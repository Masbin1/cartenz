# LinkedERP Connector

**Status: not started. Phase 6 of the roadmap.**

The connector is a separate Python application installed on a customer server
beside the Odoo runtime. It is the only component of the platform that is not
TypeScript, and the reason is recorded in ADR-10 of the approved Framework and
Technology Selection: it must interoperate with the Odoo runtime, which is
Python.

Nothing in this directory is implemented. It is documented here so that the
boundary is explicit rather than discovered later.

## Design constraints, from the approved architecture

1. **Outbound only.** The connector establishes an outbound HTTPS or secure
   WebSocket connection to the platform. The platform never requires inbound SSH
   or any other inbound access to the customer server.

2. **Mutual TLS.** The connector-to-platform channel authenticates in both
   directions: the server verifies the connector and the connector verifies the
   server.

3. **Contract-first and language-neutral.** The protocol is defined
   independently of both implementations, so the platform side remains entirely
   TypeScript and the connector can be reimplemented without changing it.

4. **Data-blind by default.** The connector returns metadata, sanitised logs and
   aggregated or anonymised results. Production database records are denied by
   default. Export and backup are never available. Where an exceptional
   debugging case requires database state, the connector minimises the field
   set and removes personally identifiable information *before* anything leaves
   the customer environment — not after it arrives.

5. **The customer database never leaves the customer server.** Queries run
   locally. The platform holds no copy.

## Intended layout

```
connector/
  app/
    client.py      Outbound channel to the platform
    auth.py        Mutual TLS and connector identity
    config.py      Configuration, read from the customer's own file
    tools/
      repository.py
      git.py
      odoo.py
      service.py
      logs.py
    main.py
  requirements.txt
```

The tool modules mirror the platform's own tool categories, and each request
still passes through the platform's permission validator and approval system
before it reaches the connector. The connector is an execution surface, not a
decision-making one.
