# Requirements Document

## Introduction

This document defines the requirements for conducting a deep architecture audit of the PERSONIFI-ARIA codebase. The audit maps the existing TypeScript codebase against the canonical ARIA dual-model architecture specification — which defines four layers (ALPHA, SENTINEL, FUSION ENGINE, PULSE + DATA) operating across REACTIVE and PROACTIVE modes — and produces a structured compliance report identifying what exists, what is partial, what is missing, and what violates the intended design.

The audit is a planning artifact. It does not execute the system. It performs static analysis, structural mapping, responsibility tracing, and violation detection.

## Glossary

- **Audit_Engine**: The audit process and tooling responsible for analyzing the codebase
- **Architecture_Spec**: The canonical ARIA dual-model architecture definition used as the compliance baseline
- **ALPHA_Layer**: Model 1 — user-facing reasoning layer (Groq 70B), responsible for NLU, response generation, tool calling, and signal writing
- **SENTINEL_Layer**: Model 2 — background intelligence layer (Ollama Nemotron 70B / Qwen fallback), responsible for stimulus scanning, preference extraction, memory processing, topic follow-up, and social monitoring
- **Fusion_Engine**: Central routing brain responsible for mode switching, proactive evaluation, and pipeline orchestration between ALPHA and SENTINEL
- **Pulse_Engine**: Behavior state machine tracking user engagement scores and state transitions (PASSIVE → CURIOUS → ENGAGED → PROACTIVE)
- **Data_Layer**: Repositories, database models, and persistence contracts for all system state
- **Compliance_Report**: The structured output document produced by the audit
- **Architecture_Tree**: A hierarchical map of all expected vs actual modules in the codebase
- **Pipeline_Trace**: A step-by-step trace of a request through a specific execution path
- **Violation**: Any module, pattern, or data flow that contradicts the Architecture_Spec
- **Ghost_Module**: A module referenced in the Architecture_Spec that has no corresponding implementation
- **Orphan_Module**: An implemented module with no clear mapping to any Architecture_Spec component
- **Reactive_Mode**: The synchronous request-response pipeline triggered by user messages
- **Proactive_Mode**: The background stimulus-driven pipeline that initiates outbound messages
- **Compliance_Status**: One of: EXISTS, PARTIAL, MISSING, VIOLATION

## Requirements

### Requirement 1: Architecture Tree Generation

**User Story:** As an architect reviewing PERSONIFI-ARIA, I want a complete map of all expected architectural components against what actually exists in the codebase, so that I can immediately see the coverage and gap surface.

#### Acceptance Criteria

1. THE Audit_Engine SHALL produce an Architecture_Tree that lists every component defined in the Architecture_Spec with its Compliance_Status
2. WHEN a component exists in the codebase but does not match the expected module boundary or responsibility, THE Audit_Engine SHALL assign it a Compliance_Status of PARTIAL and document the deviation
3. WHEN a component defined in the Architecture_Spec has no corresponding file or module in the codebase, THE Audit_Engine SHALL assign it a Compliance_Status of MISSING and flag it as a Ghost_Module
4. WHEN a module exists in the codebase with no mapping to any Architecture_Spec component, THE Audit_Engine SHALL flag it as an Orphan_Module
5. THE Architecture_Tree SHALL cover all six expected module groups: alpha/, sentinel/, fusion/, pulse/, data/, and tools/

### Requirement 2: Module-to-Responsibility Map

**User Story:** As an architect, I want each implemented module mapped to its declared responsibility, so that I can verify that modules are doing what the architecture intends.

#### Acceptance Criteria

1. THE Audit_Engine SHALL produce a Module_Responsibility_Map that lists each discovered source file alongside its inferred responsibility based on exports, function signatures, and naming
2. WHEN a module's inferred responsibility conflicts with the responsibility assigned to it by the Architecture_Spec, THE Audit_Engine SHALL flag it as a Violation
3. WHEN a single module performs responsibilities that the Architecture_Spec assigns to two or more distinct components, THE Audit_Engine SHALL flag it as a boundary violation
4. THE Module_Responsibility_Map SHALL cover all TypeScript source files under src/
5. WHEN a module has no discernible responsibility (empty exports, stub implementations, or dead code), THE Audit_Engine SHALL flag it as an unresolved module

### Requirement 3: Reactive Pipeline Trace

**User Story:** As an architect, I want a complete trace of the reactive (user-message-driven) pipeline from webhook ingestion to response delivery, so that I can verify the pipeline is correctly implemented and sequenced.

#### Acceptance Criteria

1. THE Audit_Engine SHALL trace the Reactive_Mode pipeline starting from the inbound webhook handler through sanitization, cognitive classification, tool routing, personality composition, response generation, and channel delivery
2. WHEN a required pipeline stage is absent from the codebase, THE Audit_Engine SHALL mark it as MISSING in the trace
3. WHEN a pipeline stage exists but is invoked out of the sequence defined in the Architecture_Spec, THE Audit_Engine SHALL flag it as a sequencing Violation
4. THE Reactive_Pipeline_Trace SHALL identify the specific file and function responsible for each pipeline stage
5. WHEN the 8B classifier and 70B generator are not implemented as distinct model invocations, THE Audit_Engine SHALL flag it as a dual-model architecture Violation

### Requirement 4: Proactive Pipeline Trace

**User Story:** As an architect, I want a complete trace of the proactive (stimulus-driven) pipeline from stimulus detection through engagement evaluation to outbound message delivery, so that I can verify the background intelligence loop is correctly wired.

#### Acceptance Criteria

1. THE Audit_Engine SHALL trace the Proactive_Mode pipeline starting from stimulus ingestion (weather, traffic, festival) through the Pulse_Engine, Fusion_Engine evaluation, proactive intent selection, and outbound channel delivery
2. WHEN the stimulus sources are not connected to the Pulse_Engine or Fusion_Engine, THE Audit_Engine SHALL flag it as a pipeline disconnection Violation
3. WHEN the proactive pipeline bypasses the engagement state gate (i.e., sends messages regardless of Pulse state), THE Audit_Engine SHALL flag it as a behavioral Violation
4. THE Proactive_Pipeline_Trace SHALL identify the cron or scheduler entry point that triggers the proactive loop
5. WHEN no proactive pipeline entry point exists, THE Audit_Engine SHALL flag the entire Proactive_Mode as MISSING

### Requirement 5: Pulse Engine Trace

**User Story:** As an architect, I want a detailed trace of the Pulse Engine state machine, so that I can verify engagement scoring, state transitions, and gating behavior are correctly implemented.

#### Acceptance Criteria

1. THE Audit_Engine SHALL trace the Pulse_Engine implementation and verify it implements the four-state machine: PASSIVE, CURIOUS, ENGAGED, PROACTIVE
2. WHEN a state transition defined in the Architecture_Spec (e.g., ENGAGED → PROACTIVE when score >= 80) is absent or uses different thresholds, THE Audit_Engine SHALL flag it as a state machine Violation
3. THE Audit_Engine SHALL verify that the Pulse_Engine gates proactive outreach — i.e., that PASSIVE state suppresses outbound messages
4. WHEN engagement score computation does not account for the signal types defined in the Architecture_Spec (tool interaction, follow-up, session gap), THE Audit_Engine SHALL flag the scoring model as incomplete
5. THE Pulse_Engine_Trace SHALL identify the persistence mechanism used for engagement state and verify it matches the Data_Layer specification

### Requirement 6: Sentinel Loop Trace

**User Story:** As an architect, I want a trace of the SENTINEL background intelligence loop, so that I can determine whether background processing, preference extraction, and memory enrichment are implemented as a distinct model layer.

#### Acceptance Criteria

1. THE Audit_Engine SHALL determine whether a SENTINEL_Layer exists as a distinct processing unit separate from the ALPHA_Layer
2. WHEN background intelligence functions (preference extraction, memory processing, topic follow-up, social monitoring) are implemented inline within the ALPHA_Layer pipeline, THE Audit_Engine SHALL flag it as a layer boundary Violation
3. THE Audit_Engine SHALL trace how the SENTINEL_Layer (or its equivalent) is triggered — whether by cron, event, or message hook
4. WHEN the SENTINEL_Layer uses a different model provider than specified (Ollama Nemotron 70B / Qwen fallback), THE Audit_Engine SHALL document the deviation as a configuration divergence
5. IF no SENTINEL_Layer implementation exists, THEN THE Audit_Engine SHALL flag the entire SENTINEL_Layer as MISSING and list all Ghost_Modules within it

### Requirement 7: Tool Execution Trace

**User Story:** As an architect, I want a trace of the tool execution subsystem, so that I can verify tool registration, dispatch, argument extraction, and result injection are correctly implemented.

#### Acceptance Criteria

1. THE Audit_Engine SHALL enumerate all registered tools in the tools/ directory and verify each has a corresponding registration entry in the tool registry
2. WHEN a tool is implemented but not registered in the tool registry, THE Audit_Engine SHALL flag it as an unregistered tool Violation
3. THE Audit_Engine SHALL trace the tool dispatch path from classifier output (tool_call intent) through argument extraction to tool execution and result injection into the prompt composition stage
4. WHEN tool results are not injected into the personality/prompt composition stage before the 70B generator is called, THE Audit_Engine SHALL flag it as a data flow Violation
5. THE Tool_Execution_Trace SHALL verify that tool caching, error handling, and fallback behavior are present for each tool category

### Requirement 8: Data Model Validation

**User Story:** As an architect, I want the database schema and TypeScript data models validated against the Architecture_Spec's data contracts, so that I can identify missing tables, mismatched types, and broken persistence contracts.

#### Acceptance Criteria

1. THE Audit_Engine SHALL compare all SQL schema files in database/ against the data entities required by the Architecture_Spec (pulse state, memory blocks, proactive intent, conversation agenda, engagement metrics, identity, social graph)
2. WHEN a required data entity has no corresponding SQL table or TypeScript type definition, THE Audit_Engine SHALL flag it as a MISSING data contract
3. WHEN a SQL schema column type or constraint contradicts the TypeScript type definition for the same entity, THE Audit_Engine SHALL flag it as a type contract Violation
4. THE Audit_Engine SHALL verify that all database migrations in database/migrations/ are consistent with the current schema files
5. WHEN a TypeScript repository or data-access module reads or writes fields not present in the corresponding SQL schema, THE Audit_Engine SHALL flag it as a schema drift Violation

### Requirement 9: Architecture Violations Report

**User Story:** As an architect, I want a consolidated list of all detected violations, so that I can prioritize fixes and understand the severity of architectural debt.

#### Acceptance Criteria

1. THE Audit_Engine SHALL produce an Architecture_Violations section that consolidates all Violations detected across all pipeline traces and module maps
2. WHEN producing the violations list, THE Audit_Engine SHALL classify each Violation by category: layer boundary, sequencing, behavioral, data flow, type contract, schema drift, or configuration divergence
3. THE Audit_Engine SHALL assign each Violation a severity level: CRITICAL (breaks core behavior), MAJOR (degrades intended behavior), or MINOR (deviates from spec without functional impact)
4. WHEN two or more Violations share a root cause, THE Audit_Engine SHALL group them and identify the root cause
5. THE Architecture_Violations section SHALL include the file path, function or module name, and a plain-language description for each Violation

### Requirement 10: Missing Components Report

**User Story:** As an architect, I want a complete list of all Ghost_Modules and unimplemented components, so that I know exactly what needs to be built to reach full architectural compliance.

#### Acceptance Criteria

1. THE Audit_Engine SHALL produce a Missing_Components section listing every Ghost_Module identified during the audit
2. FOR EACH Ghost_Module, THE Audit_Engine SHALL specify the Architecture_Spec layer it belongs to, its expected responsibility, and its expected interface contract
3. WHEN a Ghost_Module is a dependency of an existing implemented module, THE Audit_Engine SHALL flag the dependency as broken and identify the affected modules
4. THE Missing_Components section SHALL distinguish between components that are entirely absent and components that are partially stubbed
5. THE Audit_Engine SHALL estimate the implementation complexity of each Ghost_Module as: LOW (utility/wrapper), MEDIUM (stateful service), or HIGH (multi-dependency orchestrator)

### Requirement 11: Refactor Plan

**User Story:** As an architect, I want a concrete refactor plan that maps violations and missing components to specific code changes, so that the team has actionable guidance for bringing the codebase into compliance.

#### Acceptance Criteria

1. THE Audit_Engine SHALL produce a Refactor_Plan that maps each CRITICAL and MAJOR Violation to a specific remediation action
2. WHEN a remediation requires moving code between modules, THE Audit_Engine SHALL specify the source module, target module, and the boundary being enforced
3. WHEN a remediation requires introducing a new module, THE Audit_Engine SHALL specify the module name, location, exported interface, and dependencies
4. THE Refactor_Plan SHALL not prescribe implementation details — it SHALL specify what must change and why, not how to implement it
5. WHEN a refactor action has a dependency on another refactor action, THE Audit_Engine SHALL sequence them and flag the dependency

### Requirement 12: Implementation Priority List

**User Story:** As an architect, I want a prioritized list of implementation tasks derived from the audit, so that the team can execute the remediation in the correct order without creating new violations.

#### Acceptance Criteria

1. THE Audit_Engine SHALL produce an Implementation_Priority_List ordered by: (1) CRITICAL violations, (2) broken dependencies, (3) MISSING HIGH-complexity components, (4) MAJOR violations, (5) MISSING MEDIUM/LOW components, (6) MINOR violations
2. WHEN two items have equal priority, THE Audit_Engine SHALL order them by the number of downstream modules they unblock
3. THE Implementation_Priority_List SHALL include an estimated effort category for each item: SMALL (< 1 day), MEDIUM (1–3 days), LARGE (> 3 days)
4. WHEN an item in the Implementation_Priority_List corresponds to a Ghost_Module, THE Audit_Engine SHALL link it to the Missing_Components entry
5. THE Implementation_Priority_List SHALL be self-contained — each item SHALL include enough context to be actioned without cross-referencing other sections of the Compliance_Report
