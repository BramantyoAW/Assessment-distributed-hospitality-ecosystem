/**
 * Access tokens for the BigQuery REST calls.
 *
 * No service-account JSON key anywhere: on a GCE/Cloud Run host the metadata
 * server hands out a short-lived token for the attached identity, which is what
 * the security requirement asks for. On an on-prem camera host there is no
 * metadata server; that path is Workload Identity Federation, which needs a real
 * IdP and is therefore documented (`deploy/wif.md`) rather than faked here.
 */

export interface TokenProvider {
  getAccessToken(): Promise<string>;
}

const METADATA_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

export function createMetadataTokenProvider(fetchImpl: typeof fetch = fetch): TokenProvider {
  return {
    async getAccessToken(): Promise<string> {
      const response = await fetchImpl(METADATA_URL, {
        headers: { 'Metadata-Flavor': 'Google' },
      });

      if (!response.ok) {
        throw new Error(
          `metadata server refused a token (${response.status}); is an attached service ` +
            `account available on this host?`,
        );
      }

      const payload = (await response.json()) as { access_token?: unknown };
      if (typeof payload.access_token !== 'string' || payload.access_token === '') {
        throw new Error('metadata server returned no access_token');
      }

      return payload.access_token;
    },
  };
}

/** Tests and local runs only. Never constructed from the environment. */
export function createStaticTokenProvider(token: string): TokenProvider {
  return {
    getAccessToken: async (): Promise<string> => token,
  };
}
