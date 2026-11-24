import { useEffect, useState } from 'react';
import { emptyStatus, StatusController, type Status } from './statusController';

export type { Status } from './statusController';
export { shouldRefreshForSelection } from './statusController';

/** The controller owns cleanup, including already-running IPC continuations. */
export function useStatus(workspacePath: string): Status {
  const [status, setStatus] = useState<Status>(() => emptyStatus(workspacePath));
  useEffect(() => {
    const controller = new StatusController(workspacePath, setStatus);
    controller.start();
    return () => controller.stop();
  }, [workspacePath]);
  // Effects run after render. Never flash the old workspace for that frame.
  return status.workspacePath === workspacePath ? status : emptyStatus(workspacePath);
}
