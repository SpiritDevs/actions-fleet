# CI fleet

A shared execution service that lets selected GitHub projects use enrolled Macs and Linux machines for their workflow jobs while retaining GitHub Actions as the coordinator.

## Language

**CI host**:
An enrolled Mac or Linux machine that supplies compute capacity to the service, whether local or remote.
_Avoid_: Blacksmith replacement machine

**Fleet**:
The collection of CI hosts available to execute jobs for enrolled repositories.
_Avoid_: Single runner

**Enrolled repository**:
A GitHub repository explicitly admitted to use the local CI service.
_Avoid_: Any repository

**Hosted fallback**:
An explicitly selected alternative execution destination used when local execution is unavailable or unsuitable.
_Avoid_: Automatic failover

**Fleet dashboard**:
The shared interface for monitoring CI hosts, viewing live job output and history, and remotely controlling fleet operations.
_Avoid_: Per-repository Actions page

**Fleet relay**:
The shared service that connects operators with CI hosts for live output, machine status, and remote controls, with history retained independently of an individual host.
_Avoid_: Per-machine tunnel, workflow scheduler

**GitHub connection**:
An authorization that grants the service access to selected repositories belonging to a GitHub account or organization.
_Avoid_: Dashboard login

**Fleet operator**:
A person granted access to view or control the fleet through its dashboard. Authorizing a GitHub connection does not itself grant operator access.
_Avoid_: Connected account owner

**Dedicated mode**:
A host mode that makes the machine's configured build capacity available to the fleet without reserving a share for interactive work. It does not imply a preference in job placement.
_Avoid_: Primary build machine

**Shared mode**:
A host mode that moderates build activity to keep capacity available for other work. With native execution, moderation is best-effort rather than a strict resource boundary.
_Avoid_: Partial build machine

**Paused mode**:
A host mode that accepts no new jobs and lets running jobs finish while the installed service remains available for monitoring and control.
_Avoid_: Offline, stop all jobs

**Outside contribution**:
Code submitted to an enrolled repository by someone outside its trusted maintainers; fleet execution requires a maintainer's explicit approval.
_Avoid_: Connected account

**Native execution**:
Workflow jobs run directly on the enrolled machine using its operating system and installed tools, as local builds do.
_Avoid_: Disposable VM job
