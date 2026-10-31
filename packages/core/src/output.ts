import type { SessionId } from '@helix/contracts';

/** Trusted static artifact host. Never executes project scripts/configuration. */
export interface OutputHost {
  start(input: {
    workerSessionId: SessionId;
    path: string;
    headSha: string;
    signal: AbortSignal;
  }): Promise<{ artifactHash: string; url: string }>;
  stop(id: SessionId): Promise<void>;
  lease(id: SessionId): { artifactHash: string; url: string } | undefined;
}

export const outputInstructions = `\n\nLive Output: in an orchestrated Build, assign exactly one UI task ownership of .helix/output/** in the reviewed plan, with dependent UI changes coordinated through that owner. Workers must not edit this export outside their approved file ownership. For the owning task (or a direct UI task), when runnable browser UI exists, build the actual application source and copy its self-contained compiled browser bundle into .helix/output/index.html with relative asset URLs. Use the existing project build command within your approved task; for a plain HTML/CSS/JS application, copy those actual application assets. Never author a separate imitation or mock for Output. Include that export in your edits at each meaningful UI milestone; Helix commits and serves the committed artifact automatically at turn boundaries. Do not start a separate server. The preview supports client-side UI/scripts. Backend APIs, external resource requests, cookies, persistent storage and service workers are not supported. Browser isolation is not a promise of complete network confinement. Never include credentials, private source maps or unrelated files. Use the existing approved brief/design; Output feedback is a bounded change request, never design/plan/merge approval. If the app needs a backend or cannot export, explain the limitation instead of fabricating a working app.`;
