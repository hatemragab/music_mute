import { http, HttpResponse } from "msw";
import { fromWireCase, fromWireUrl, toWireCase } from "../api/wire-case";

import {
  createDashboardFixture,
  type DashboardFixture,
} from "./dashboard-fixtures";

export const createDashboardHandlers = (
  fixture: DashboardFixture = createDashboardFixture(),
) => [
  http.all(/\/admin\//, async ({ request }) => {
    const authorization = request.headers.get("authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
    const body = ["GET", "HEAD"].includes(request.method)
      ? undefined
      : await request
          .clone()
          .json()
          .catch(() => undefined);
    const response = await fixture.handle({
      method: request.method,
      url: fromWireUrl(request.url),
      token,
      body: fromWireCase(body),
    });
    return typeof response.body === "string"
      ? new HttpResponse(response.body, {
          status: response.status,
          headers: response.headers,
        })
      : HttpResponse.json(
          toWireCase(response.body) as Record<string, unknown>,
          {
            status: response.status,
            headers: response.headers,
          },
        );
  }),
];
