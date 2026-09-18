using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using GitHub.DistributedTask.WebApi;
using GitHub.Runner.Worker;
using Moq;
using Xunit;

namespace GitHub.Runner.Common.Tests.Worker
{
    // Extends upstream's real StepsRunner harness, including its expression
    // evaluator. These exercise the actual dispatch loop rather than a fake
    // shell which already exits when the hook fails.
    public sealed partial class StepsRunnerL0
    {
        [Theory]
        [InlineData(TaskResult.Failed)]
        [InlineData(TaskResult.Canceled)]
        [InlineData(TaskResult.Skipped)]
        [Trait("Level", "L0")]
        [Trait("Category", "Worker")]
        public async Task FleetDeniedHookBlocksAlwaysFailureAndPostActions(TaskResult hookResult)
        {
            var oldRequired = Environment.GetEnvironmentVariable("FLEET_REQUIRE_ADMISSION");
            var oldPath = Environment.GetEnvironmentVariable("ACTIONS_RUNNER_HOOK_JOB_STARTED");
            Environment.SetEnvironmentVariable("FLEET_REQUIRE_ADMISSION", "1");
            Environment.SetEnvironmentVariable("ACTIONS_RUNNER_HOOK_JOB_STARTED", "/fleet-hook.sh");
            try
            {
                using (var hc = CreateTestContext())
                {
                    var hookContext = CreateStep(hc, hookResult, "always()", name: "hook-context").Object.ExecutionContext;
                    var hook = new JobExtensionRunner((context, data) => { context.Result = hookResult; return Task.CompletedTask; }, "always()", "Fleet admission", new JobHookData(ActionRunStage.Pre, "/fleet-hook.sh")) { ExecutionContext = hookContext };
                    var always = CreateStep(hc, TaskResult.Succeeded, "always()", name: "attacker-always");
                    var failure = CreateStep(hc, TaskResult.Succeeded, "failure()", name: "attacker-failure");
                    var post = CreateStep(hc, TaskResult.Succeeded, "always()", name: "attacker-post");
                    _ec.Setup(x => x.JobSteps).Returns(new Queue<IStep>(new IStep[] { hook, always.Object, failure.Object }));
                    _ec.Object.PostJobSteps.Push(post.Object);
                    await _stepsRunner.RunAsync(_ec.Object);
                    always.Verify(x => x.RunAsync(), Times.Never());
                    failure.Verify(x => x.RunAsync(), Times.Never());
                    post.Verify(x => x.RunAsync(), Times.Never());
                    Assert.Equal(TaskResult.Failed, _ec.Object.Result);
                    Assert.Empty(_ec.Object.JobSteps);
                    Assert.Empty(_ec.Object.PostJobSteps);
                }
            }
            finally
            {
                Environment.SetEnvironmentVariable("FLEET_REQUIRE_ADMISSION", oldRequired);
                Environment.SetEnvironmentVariable("ACTIONS_RUNNER_HOOK_JOB_STARTED", oldPath);
            }
        }

        [Fact]
        [Trait("Level", "L0")]
        [Trait("Category", "Worker")]
        public async Task FleetMissingHookCannotBeSpoofedByAnActionName()
        {
            var oldRequired = Environment.GetEnvironmentVariable("FLEET_REQUIRE_ADMISSION");
            var oldPath = Environment.GetEnvironmentVariable("ACTIONS_RUNNER_HOOK_JOB_STARTED");
            Environment.SetEnvironmentVariable("FLEET_REQUIRE_ADMISSION", "1");
            Environment.SetEnvironmentVariable("ACTIONS_RUNNER_HOOK_JOB_STARTED", "/fleet-hook.sh");
            try
            {
                using (var hc = CreateTestContext())
                {
                    var spoof = CreateStep(hc, TaskResult.Succeeded, "always()", name: "Set up runner");
                    _ec.Setup(x => x.JobSteps).Returns(new Queue<IStep>(new[] { spoof.Object }));
                    await _stepsRunner.RunAsync(_ec.Object);
                    spoof.Verify(x => x.RunAsync(), Times.Never());
                    Assert.Equal(TaskResult.Failed, _ec.Object.Result);
                }
            }
            finally
            {
                Environment.SetEnvironmentVariable("FLEET_REQUIRE_ADMISSION", oldRequired);
                Environment.SetEnvironmentVariable("ACTIONS_RUNNER_HOOK_JOB_STARTED", oldPath);
            }
        }

        [Fact]
        [Trait("Level", "L0")]
        [Trait("Category", "Worker")]
        public async Task FleetSuccessfulHookPreservesNormalStepsAndPostActions()
        {
            var oldRequired = Environment.GetEnvironmentVariable("FLEET_REQUIRE_ADMISSION");
            var oldPath = Environment.GetEnvironmentVariable("ACTIONS_RUNNER_HOOK_JOB_STARTED");
            Environment.SetEnvironmentVariable("FLEET_REQUIRE_ADMISSION", "1");
            Environment.SetEnvironmentVariable("ACTIONS_RUNNER_HOOK_JOB_STARTED", "/fleet-hook.sh");
            try
            {
                using (var hc = CreateTestContext())
                {
                    var hookContext = CreateStep(hc, TaskResult.Succeeded, "always()", name: "hook-context").Object.ExecutionContext;
                    var hook = new JobExtensionRunner((context, data) => Task.CompletedTask, "always()", "Fleet admission", new JobHookData(ActionRunStage.Pre, "/fleet-hook.sh")) { ExecutionContext = hookContext };
                    var action = CreateStep(hc, TaskResult.Succeeded, "always()", name: "normal-action");
                    var post = CreateStep(hc, TaskResult.Succeeded, "always()", name: "normal-post");
                    _ec.Setup(x => x.JobSteps).Returns(new Queue<IStep>(new IStep[] { hook, action.Object }));
                    _ec.Object.PostJobSteps.Push(post.Object);
                    await _stepsRunner.RunAsync(_ec.Object);
                    action.Verify(x => x.RunAsync(), Times.Once());
                    post.Verify(x => x.RunAsync(), Times.Once());
                    Assert.NotEqual(TaskResult.Failed, _ec.Object.Result);
                }
            }
            finally
            {
                Environment.SetEnvironmentVariable("FLEET_REQUIRE_ADMISSION", oldRequired);
                Environment.SetEnvironmentVariable("ACTIONS_RUNNER_HOOK_JOB_STARTED", oldPath);
            }
        }
    }
}
