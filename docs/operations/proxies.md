# Proxies & IP isolation

Give each connected account its own proxy so your accounts don't all act from the same IP —
which platforms can flag when several accounts share one address (Constitution Principle VII).
Combined with the per-account persistent fingerprint, each account gets a coherent, isolated
network + browser identity.

## Set a proxy

When connecting an account, the connect page has an optional **Proxy** field:

```
http://user:pass@host:port
https://host:port
socks5://host:port
```

- Validated (scheme + host + port) at connect time.
- Stored **encrypted** (it may contain credentials); never shown back in plaintext or written
  to logs (Principle II).
- Applies to both assisted-login and claim runs for that account.
- Leave empty to use the host's own IP (unchanged behavior).

## How it's applied

The worker launches CloakBrowser with the account's proxy for every run — connectors are
unchanged (the proxy is injected at the browser layer). Two accounts with different proxies
run from different IPs.

## Recommendations

- Use **residential** proxies where the platform is sensitive; datacenter IPs are more likely
  to be flagged. Don't share one datacenter IP across multiple accounts.
- Bring-your-own: the platform doesn't bundle or rotate proxies (out of scope). Point the
  field at your own proxy/endpoint.
- If a proxy is unreachable or its auth fails, the run reports `failed` with a readable reason
  (the proxy URL/credentials never appear in the message or logs).
