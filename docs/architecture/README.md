# Architecture decisions

Architecture Decision Records describe the constraints contributors should
preserve unless a later ADR explicitly replaces them.

- [ADR-0001: One protocol, two deployment modes](0001-hosted-and-self-hosted.md)
- [ADR-0002: Separate user, Agent, and Ingest credentials](0002-credential-boundaries.md)
- [ADR-0003: Durable acceptance before asynchronous delivery](0003-durable-delivery.md)
- [ADR-0004: Keep private card payloads on the user-to-device data path](0004-private-direct-connections.md)
- [ADR-0005: Isolate authentication and business state on Cloudflare](0005-cloudflare-auth-and-d1.md)

New ADRs use the next number and contain Context, Decision, Consequences, and
Status sections. Do not rewrite accepted decisions in place; add a superseding
record so history remains reviewable.
