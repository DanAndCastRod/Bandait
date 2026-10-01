"""Web Hub (Supabase) account and one-way workspace sync for the desktop leader.

- ``auth``: Google sign-in through Supabase Auth with PKCE and a loopback
  redirect; the session lives in the OS credential store (keyring).
- ``workspace``: download, parse (v1/v2) and cache the hub workspace.
- ``sync``: fetch-or-cache plus the DB import, as one call for a worker thread.
- ``controller``: Qt glue (worker threads, results back to the UI via signals).

The leader never writes to Supabase. The show never depends on the network:
everything needed on stage is imported into the local SQLite database.
"""
