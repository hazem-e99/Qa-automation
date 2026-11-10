# ADR-0011 — Object storage: local filesystem → S3-compatible; MinIO rejected
- Status: Accepted · Date: 2026-11-09 · Deciders: Platform Engineer

## Context
Artifacts (screenshots, videos, traces, reports) and uploaded documents need durable blob storage. The brief suggested MinIO. However, MinIO Community Edition has been source-only since October 2025 and in maintenance mode since December 2025 ([36 S1](../36-technical-validation.md)), so we cannot rely on it.

## Decision
Define an `ObjectStorage` port with these adapters:
- **`localfs`** (pilot): a content-addressed layout, `/{bucket}/{projectId}/{yyyy}/{mm}/{sha256}`, on a Docker volume. The API serves downloads through signed URLs that expire.
- **`s3`** (enterprise): any S3-compatible endpoint. Company IT chooses the backend (OD-07).
- **`azure_blob`**: an optional adapter for later.

Metadata always lives in Postgres: sha256, size, MIME type, retention class, and the owning record. The storage backend holds only bytes.

## Consequences
- (+) The pilot needs no extra services.
- (−) Moving from `localfs` to S3 requires copying the files. A CLI copy job will be provided for this ([28 §4](../28-enterprise-rollout.md)).
