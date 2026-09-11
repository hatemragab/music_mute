import { setupServer } from "msw/node";

import { createDashboardHandlers } from "./handlers";

export const dashboardServer = setupServer(...createDashboardHandlers());
