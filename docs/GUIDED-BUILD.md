# Guided New Build

Intake is a durable workspace before a Build exists. Independent discovery uses GET/POST `/api/discovery` with one current conversation pointer and draft-ID-keyed SQLite metadata. No project or repository is needed to start. `GET/POST /api/projects/:id/intake` resume or mutate the project's current draft. Drafts live in scoped SQLite metadata; approved brief provenance travels in the existing `session.created` event's optional `reviewedBrief`. The original `session.prompt` remains the original outcome. No duplicate Build identity or database migration is introduced.

## Experience

The idea studio starts with a local choice: **A new project** or **An existing project**. Choosing creates nothing. The user describes a spark, problem or direction in one composer and selects **Let’s talk**. A secondary **Review as written** path preserves an already finished brief. No name field is required up front. A provisional name is derived locally from the idea, never inferred from repository contents.

The real Codex writer reflects the actual idea, proposes a useful direction and asks one consequential question. The thread shows original words, previous agent responses, offered directions and user replies. **Recommend something** and **Explore a few options** send requests to that same writer. Each answer retains the preceding assistant message and offered choices, so a natural reply such as “combine the first two” remains meaningful. Suggestions stay separate from confirmed decisions.

A compact working concept sits beside the conversation: confirmed decisions, open questions and the next step. The full editable concept is initially collapsed and opens when the important decisions are resolved. Revision-bound approval starts planning, with worker and design approval still separate. Name, original idea and earlier answer editing are disclosed in settings/history rather than required as an initial form.

The conversation is saved independently in Helix. Repository context is optional and no files are inspected. A destination is chosen explicitly only when the concept is ready for planning. Binding verifies an existing registered project and does not create a repository or launch anything. Existing project-scoped drafts remain available through an explicit resume control. The single dialog owner stays mounted outside app registration and workspace branches, preserving unsent ideas and pending replies in memory; persisted discussion survives reload. Unsent text is not guaranteed across page reloads.

All mutations use the existing single-request gate, stable request IDs and revision checks. Input and brief edits cannot silently discard each other. Failed requests re-read saved state without substituting synthetic success. An uncertain approval freezes editing and offers only same-revision retry or reconciliation. An interrupted generation can be cancelled, and late results are discarded. Current service limits and required new screenshot/reference/project-context capabilities are detailed below.

## Behaviour

Paste a brief for an immediate editable review, or choose discovery. The dedicated Codex adapter runs read-only in an isolated scratch directory using existing CLI access. It receives the outcome and answer history, asks one consequential question at a time, offers recommendations with tradeoffs, and returns a structured living brief with assumptions and cited answer IDs. It has no worker checkout or Helix orchestration launcher. Invalid output, missing provenance, timeout and unavailable CLI fail visibly; no synthetic successful agent response is substituted.

The direct path can review the user's prompt unchanged without agent latency, or request agent improvement. All intake launches create an orchestrated build. Approving the reviewed brief starts planning, not worker execution: existing plan approval, real three-concept design approval and review/CI gates remain separate.

Every mutation is revision-bound and has a persisted request receipt. Inputs or brief edits invalidate previous authorization. Generations run outside mutation locks, with cancel and revision checks discarding late output. A restart marks an orphaned generation failed and requires explicit retry. Approval durably freezes the exact brief before calling the existing idempotent create-session API. An uncertain launch can only retry the same approved payload/key, never edit into another build.

Answer edits are explicit and persisted with Save changes, Answer, Save and close, or before a repository switch. Earlier brief versions remain inspectable. Agent confirmation citations must reference actual answer IDs (or original-goal); model inference is presented separately as assumptions. Consequential unknowns block approval, including after prose edits. The model decides relevance and the stopping rule; this is not a fixed mandatory questionnaire.

Limitations: one current independent discovery draft per local daemon, plus compatible project-scoped drafts; earlier launched briefs remain with their Build events. Draft metadata is local and not part of replay exports until approval. Agent semantic accuracy still requires the user's review. Generation tests use controlled providers; see validation receipts for actual CLI/browser coverage.

## Conversation-first revision (in review)

The first screen offers **A new project** or **An existing project**. This is intent, not a create-project operation. Only sending the idea creates a draft; choosing context never creates a repository or starts a build. New concepts are saved independently in Helix. A registered repository is chosen explicitly as a destination only when the concept is ready for planning. Registering another repository remains a separate existing action; no repository is created by choosing intent.

The primary action starts a real Codex conversation. Its first response reflects the actual idea, develops a useful direction and asks one consequential question. Free replies, “Recommend something”, and “Explore a few options” use that same writer with the full answer history. The optional synthesis `message` field holds the assistant's prose; when a user responds it is retained as optional `assistantMessage` on the answer. Old drafts without either field continue to render their saved questions and answers. Suggestions are not confirmed until accepted. No scripted response is inserted into the production path.

A compact working concept accompanies the thread: confirmed decisions, open questions and the next step. Full editable prose and approval are progressively disclosed, opening when no consequential unknowns remain. Name, original-idea and previous-answer editing remain available without dominating discovery. Existing revision-bound approval, saved-input/edit exclusions, cancellation, uncertain-launch freeze and same-key retry behavior remain unchanged.

Reference-site URLs and screenshot descriptions may be supplied as plain text in the conversation. The intake writer has no fetch or image attachment channel and must say that it has not opened them. The existing design-stage image gate is not automatically an intake upload gate. Actual screenshot upload or repository inspection needs a separately scoped transport/access capability; this iteration must not claim it inspected either. Supplied reference content is untrusted data, never instructions.

Verification must distinguish the synthetic 5351 preview from a real isolated Codex writer demonstration. A first-time walkthrough by an independent agent is an agent usability review, not a novice human test.

### Remaining reference capability scope

Intake `HarnessSession.send(text, mode)` is text-only. The visual design uploader accepts up to four PNG/JPEG/WebP files of 5 MB each, converts them to data URLs, and passes them to the image-generation workflow's reference channel. It does not make those images visible to the intake Codex session. Reusing only its HTML control would falsely imply vision.

Minimal screenshot support requires a bounded validated attachment field on the draft/edit contract; pending attachment retention across close and workspace switches; compatible request-size and durable storage limits; a supported multimodal Codex harness send operation with explicit capability detection; and read-only tests proving image inputs arrive while cancellation/idempotency and attachment lifecycle remain correct. The existing visual raster validation and file-selection limits can be reused as policy. Website fetches also need an explicit bounded retrieval channel (including redirects/network restrictions and untrusted-content isolation); existing repository analysis needs an explicit read-access handoff. These channels are coordination work, not completed by the UI revision.

## Repository-independent foundation

The normal build Session contract still requires a ProjectId. Only the harness start metadata has a distinct purpose:discovery alternative: a scratch Codex conversation with no project, role, or worker launcher. The adapter fixes read-only/never/text-only behavior, removes HELIX_/GIT_ environment keys case-insensitively and disables subsequent environment inheritance. Tool requests fail closed. No real agent calls are part of this foundation's synthetic validation.

Discovery records live under discovery-drafts keyed by immutable draft identity; discovery-current points to the current one. The project-scoped build-intake namespace remains compatible. A non-string scope marker prevents any valid project name from colliding with discovery. Mutations and destination checks share serialization. Binding increments revision and invalidates authorization, retains concept/history, rejects an active legacy draft, and reserves the destination against reciprocal legacy mutations. Approval rechecks registration and collision before freezing the exact revision. Launching cannot change destination. Request receipts include the accepted draft ID, so retries after replacement conflict rather than adopting a different conversation.

App owns the dialog outside empty/live/project branches. With zero projects, the initial view opens the conversational composer, without a repository form. Existing repository registration is a separate explicit app control. Verified destination identity accompanies successful launch navigation; the app waits for that project's matching session event before opening it. Completed drafts allow switching between independent and legacy scopes while active/uncertain operations remain held.

This slice does not implement repository creation, screenshot transport, website retrieval, or repository inspection. The reference capability descriptions above remain proposals. One current independent discovery conversation is supported per local daemon.
