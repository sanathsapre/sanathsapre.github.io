# Architecture Overview

## Evolution

1. Basic data transfer
2. Non-blocking I/O
3. IOCTL control
4. Timer-based events
5. Workqueues
6. poll/select
7. Interrupt simulation

---

## Core Flow

User Space → System Calls → Driver → Event Queue → Event Source

---

## Principles

- Event-driven design
- Separation of concerns
- Safe concurrency
