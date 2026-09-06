# Small Production Architecture Flow

This diagram shows the complete request and result path for small production. Outer boxes are real machines or managed services. Inner boxes are processes or data components running inside that machine or service.

```mermaid
flowchart LR
    subgraph userMachine["REAL MACHINE: user laptop, browser, or developer workstation"]
        chat["Program: Chat UI, CLI, or API client"]
    end

    subgraph controlPlaneMachine["REAL MACHINE: cloud app host, for example Railway"]
        cp["Program: control plane API"]
        router["Program: planner and request router"]
        obs["Program: observability, policy, and credit ledger"]
    end

    subgraph queueMachine["MANAGED SERVICE: queue host"]
        queue["Queue: Valkey or Redis"]
    end

    subgraph storeMachine["MANAGED SERVICE: transactional data host"]
        tempStore["Temporary result store: active job outputs with TTL"]
        ledger["Permanent metadata ledger: status, timing, credits, no raw text by default"]
    end

    subgraph memoryMachine["MANAGED SERVICE: optional vector memory host"]
        vectorMemory["Vector DB: semantic memory and RAG, only when retention allows"]
    end

    subgraph toolMachine["PROGRAM SERVICE: tool runtime"]
        tools["Tools: weather, wiki, math, search"]
    end

    subgraph lightMachine["REAL MACHINE: contributor light worker"]
        light["Program: node agent plus small model runtime"]
    end

    subgraph mediumMachine["REAL MACHINE: contributor medium worker"]
        medium["Program: node agent plus normal model runtime"]
    end

    subgraph strongMachine["REAL MACHINE: strong GPU or high-memory worker"]
        strong["Program: node agent plus large model runtime"]
    end

    subgraph reducerMachine["REAL MACHINE: trusted reducer worker"]
        reducer["Program: dense reducer runtime"]
    end

    subgraph moeMachine["REAL MACHINE: optional specialist worker"]
        moe["Program: MoE gateway and expert runtimes"]
    end

    chat --> cp --> router
    router --> queue
    router --> tools

    queue --> light
    queue --> medium
    queue --> strong
    queue --> moe

    light --> tempStore
    medium --> tempStore
    strong --> tempStore
    moe --> tempStore
    tools --> tempStore

    tempStore --> reducer
    reducer --> tempStore

    tempStore --> cp
    cp --> chat

    tempStore --> ledger
    cp --> ledger
    tempStore -. "optional embedding after retention check" .-> vectorMemory

    cp --> obs
    ledger --> obs
```

## Reading Guide

- `REAL MACHINE` means physical or virtual hardware.
- `MANAGED SERVICE` means hosted infrastructure such as Postgres, Supabase, Valkey, Redis, or a vector database.
- `PROGRAM SERVICE` means a software service that can run on the control-plane host or a separate small host.
- `Temporary result store` keeps active job and chunk outputs so workers, reducers, and the UI can coordinate. Raw text should have TTL cleanup by default.
- `Permanent metadata ledger` keeps job status, node IDs, timing, queue data, credits, and audit metadata. It should not store raw prompts or outputs by default.
- `Vector DB` is optional memory/RAG storage. It is not the execution ledger and should only receive data allowed by retention policy.
- The reducer is not the end of the flow. It writes the final answer back to the temporary result store, then the control plane returns the answer to the client.
