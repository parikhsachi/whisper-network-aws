# Whisper Network 

A Cold War-era cryptographic laboratory / early codebreaking rooms-inspired “intelligence machine” that lets players compete to solve a shared cipher to see who can crack it first. Participants contribute sealed, anonymized “cipher tapes” to a shared system, and the only observable output is how the cipher's aggregate state evolves over time. No records, messages, or identities are ever exposed—only structured, machine-generated summaries such as entropy, overlap, and trend shifts.

The project recreates this model using the AWS suite—AWS Clean Rooms for privacy-preserving computation, Amazon S3 for sealed dataset storage, and Parquet-based analytics workflows.


## Core Idea

- Each participant contributes private data, raw inputs are never shared

- Only explicitly allowed aggregate queries may execute
- All participants see the same privacy-preserving analytics surface

- These shared signals help solve a common puzzle — but speed and insight determine the winner

