using System;
using GitHub.DistributedTask.WebApi;
using GitHub.Runner.Common;
using GitHub.Runner.Common.Util;

namespace GitHub.Runner.Worker
{
    // A normal GitHub job-start hook only fails its own step. Workflow steps
    // with always()/failure() can still run. Fleet opts into this stronger gate
    // before evaluating any contributed step or its conditions/environment.
    internal sealed class FleetAdmissionGate
    {
        private readonly string _hookPath;
        private bool _admitted;

        public FleetAdmissionGate()
        {
            _admitted = Environment.GetEnvironmentVariable("FLEET_REQUIRE_ADMISSION") != "1";
            _hookPath = Environment.GetEnvironmentVariable("ACTIONS_RUNNER_HOOK_JOB_STARTED");
        }

        private bool IsExpectedHook(IStep step)
        {
            return !string.IsNullOrEmpty(_hookPath)
                && step is JobExtensionRunner extension
                && extension.Data is JobHookData hook
                && hook.Stage == ActionRunStage.Pre
                && string.Equals(hook.Path, _hookPath, StringComparison.Ordinal);
        }

        public bool CanRun(IStep step) => _admitted || IsExpectedHook(step);

        public bool Observe(IStep step)
        {
            if (_admitted) return true;
            _admitted = IsExpectedHook(step)
                && step.ExecutionContext.Result == TaskResult.Succeeded;
            return _admitted;
        }

        public void Reject(IExecutionContext jobContext, IStep current = null)
        {
            jobContext.Error("Fleet admission did not succeed. No contributed steps or post actions will execute.");
            jobContext.Result = TaskResult.Failed;
            jobContext.JobContext.Status = TaskResult.Failed.ToActionResult();
            if (current != null) Skip(current);
            while (jobContext.JobSteps.Count > 0) Skip(jobContext.JobSteps.Dequeue());
            while (jobContext.PostJobSteps.TryPop(out var post)) Skip(post);
        }

        private static void Skip(IStep step)
        {
            step.ExecutionContext.Start();
            step.ExecutionContext.Complete(TaskResult.Skipped);
        }
    }
}
