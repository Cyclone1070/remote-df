# Architecture Guidelines

This document provides decision rules for file placement, code organization, streaming mechanics, and architecture guardrails when adding or modifying features in Remote-DF.

---

## Core Architectural Rules

1. **Feature Slices (`server/features/<slice>/`)**
   - Modules are organized strictly by **Domain**, not technical layers (e.g. `config/` manages deployment modes; `games/` manages manifests and tags; `session/` manages game process lifecycle).
   - Each domain feature is an isolated, independent vertical slice.
   - Slices MUST NOT import concrete files directly from peer feature slices.
   - Cross-slice communication occurs via domain contracts (`server/domain/`) or composition root wiring in `main.go`.

2. **Domain Package (`server/domain/`)**
   - `server/domain/` is a shared type-and-contract package.
   - Contains ONLY pure Go interfaces (`*Registry`) and shared data structures (`*Manifest`, `*Response`).
   - ZERO concrete service logic, ZERO framework dependencies.
   - Put a type or contract here ONLY if it is consumed by 2 or more feature slices (anti-dumping guardrail).

3. **Architecture Guardrails (Enforced via `server/tests/architecture_test.go`)**
   - **Rule 1: Domain Isolation**: `domain/` has zero dependencies on feature slices or infrastructure.
   - **Rule 2: Zero Cross-Slice Concrete Imports**: Feature slices only import from `domain/` or own directory.
   - **Rule 3: Infrastructure Independence**: Infrastructure components cannot import feature slices.
   - **Rule 4: Domain Anti-Dumping**: Contracts and interfaces in `domain/` must be cross-slice (consumed by 2 or more slices).
   - **Rule 5: Zero Bidirectional Slice Coupling**: Slices must have an acyclic dependency graph (no direct circular imports or contract cycles).
   - **Rule 6: Single Model / Entity Ownership**: Every entity/model is owned exclusively by a single domain slice.
   - **Rule 7: Route Domain Ownership**: Controllers only declare routes belonging to their owning domain slice.

4. **Infrastructure (`server/infrastructure/`)**
   - Reusable technical adapters (logging, streamer reverse proxy, SPA router) reside in `server/infrastructure/`.
   - Infrastructure must remain independent of domain business logic.

5. **Deployment & Blackbox Testing (`deployment/`)**
   - Centralized Docker configuration in `deployment/docker/`.
   - Blackbox E2E test suites in `deployment/tests/` verifying health, games discovery, session lifecycle, and zero-zombie process termination.

---

## File Placement & Naming Guide

| What are you adding? | File Placement | File Naming | Export / Token Name |
| :--- | :--- | :--- | :--- |
| **HTTP Controller** | `server/features/<feature>/` | `<name>_controller.go` | `[Name]Controller` |
| **HTTP Request/Response DTO** | `server/features/<feature>/dto/` | `<name>.go` | `[Name]Request` / `[Name]Dto` |
| **Feature Service** | `server/features/<feature>/` | `<name>_service.go` | `[Name]Service` |
| **Feature-Internal Model/Type** | `server/features/<feature>/` | `types.go` or `<name>.go` | `[Name]` |
| **Cross-Slice Domain Contract** | `server/domain/` | `<concept>.go` | `[Concept]Registry` |
| **Cross-Slice Domain Payload** | `server/domain/` | `<concept>.go` | `[Concept]Manifest` |
| **Infrastructure Adapter** | `server/infrastructure/<service>/` | `<service>.go` | `[Service]Proxy` / `Logger` |
| **Docker Compose Services** | `deployment/docker/` | `docker-compose.yml` | `[Service]` container |
| **E2E Integration Test Suite** | `deployment/tests/suites/` | `XX-<name>.sh` | Shell test script |
