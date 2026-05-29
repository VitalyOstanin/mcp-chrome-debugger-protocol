# Architecture Decision Records

This directory holds Architecture Decision Records (ADRs) — short documents that
capture a single significant architectural decision, its context, and its
consequences.

## Table of Contents

- [What is an ADR](#what-is-an-adr)
- [How to add a new ADR](#how-to-add-a-new-adr)
- [Index](#index)

## What is an ADR

An ADR records one architecturally significant decision. The format used here is
[Michael Nygard's template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
See [template.md](template.md).

## How to add a new ADR

1. Copy [template.md](template.md) to `NNNN-short-title.md`, where `NNNN` is the
   next zero-padded sequence number.
2. Fill in the sections. Set `Status` to `Proposed`, then `Accepted` once agreed.
3. Add an entry to the [Index](#index) below.
4. Never edit the decision body of an accepted ADR; instead add a new ADR that
   supersedes it and update the statuses.

## Index

- [ADR-0001: Record architecture decisions](0001-record-architecture-decisions.md)
