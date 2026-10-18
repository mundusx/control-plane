# Native coding stream cancellation

Native tool clients such as VS Code's generic OpenAI-compatible provider do not call MundusX's custom cancellation endpoint. A disconnected native stream therefore cancels its queued or assigned job by default. The job remains in the audit history with its cancellation status; the scheduler releases its assignment and the contributor observes the cancelled assignment.

This applies when the connection fails before streaming starts, while waiting for admission, or while streaming an admitted job. Model validation failures and ordinary timeouts are not interpreted as a client disconnect.

Ordinary conversational streams retain their existing resumable behavior. A native client implementing explicit resume may opt into retention with `X-MundusX-Retain-On-Disconnect: true`. It must use the returned resume token for status and cancellation; the header grants no access to another request.

Validation includes an actual HTTP stream shutdown with an assigned job and a check that the node becomes ready again. Output already applied by the host is not rolled back by cancellation.
