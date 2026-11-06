/**
 * The site key the permissions manager uses (toolbox WalletPermissionsManager.normalizeOriginator): the hostname
 * only, lower case, IPv6 in brackets, NO port. BRC-100 permission authority is hostname-scoped, so every port of a
 * host is one site to the manager, and the requests it raises carry this form.
 *
 * Every per-site table that a request is looked up in (spend recipients, labels on the spend sheet, the Seal pass,
 * protocol and pay calls in flight) must be keyed with this, not with @1sat normalizeOriginator, which keeps a
 * non-default port: "shop.example" and "shop.example:8443" were two sites to us and one to the manager
 * (review of fix/sheet-recipients, 6 Nov 2026).
 */
export const permissionSite = (originator: unknown): string => {
  if (typeof originator !== 'string') return '';
  const trimmed = originator.trim();
  if (!trimmed) return '';
  try {
    const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(candidate);
    if (!url.hostname) return trimmed.toLowerCase();
    const hostname = url.hostname.toLowerCase();
    return hostname.includes(':') ? `[${hostname}]` : hostname;
  } catch {
    return trimmed.toLowerCase();
  }
};
