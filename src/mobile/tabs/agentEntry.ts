/**
 * The b agent entry in the classic layout's side menu (5.1.86). The top-bar b became the
 * Airdrops button, so the drawer carries the agent now. Same behaviour as the old top-bar b:
 * opens /m/agent, and goes back when the agent is already open.
 */
export const AGENT_ROUTE = '/m/agent';

/** Where the menu's "b agent" goes from `pathname`: back (-1) if already on the agent, else the agent. */
export const agentMenuTarget = (pathname: string): typeof AGENT_ROUTE | -1 =>
  pathname.startsWith(AGENT_ROUTE) ? -1 : AGENT_ROUTE;

/** The phone layout keeps its own ways in (dock b hold, pull-down), so only the classic drawer shows it. */
export const showAgentInMenu = (phoneLayout: boolean) => !phoneLayout;
