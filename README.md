# Whisper Network 

A Cold War-era cryptographic laboratory / early codebreaking rooms-inspired “intelligence machine” that lets multiple organizations collaborate without sharing raw data. Multiple participants contribute sealed, anonymized “cipher tapes” to a shared analytical system, and the only observable output is how the system’s aggregate state evolves over time. No records, messages, or identities are ever exposed—only structured, machine-generated summaries such as entropy, overlap, and trend shifts.

The project recreates this model using modern cloud primitives, treating computation itself as the medium of collaboration. 


## Status (Work in Progress)
- Phase 1 scaffolding is complete: monorepo, local encoder, machine stub, and dashboard shell.
- Synthetic cipher tapes are generated locally as Parquet for Athena and Clean Rooms compatibility.
- AWS resources (S3, Glue, Clean Rooms) are not connected yet.
- The dashboard currently renders placeholder state data.

## Next steps
- Upload encoded tapes to S3 and catalog them in Glue for Athena querying.
- Create a Clean Rooms collaboration, memberships, configured tables, and aggregation-only analysis rules.
- Implement the machine runner to execute allowed queries and write state outputs to S3.
- Update the dashboard to read and render live machine state outputs.
