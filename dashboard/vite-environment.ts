import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export type DashboardEnvironment = Record<string, string | undefined> & {
  APP_ENV: "local" | "production" | "test";
  NODE_ENV: "development" | "production" | "test";
};

const validateProfile = (
  environment: Record<string, string | undefined>,
): DashboardEnvironment => {
  const appEnvironment = environment.APP_ENV?.trim() || "local";
  const nodeEnvironment = environment.NODE_ENV?.trim() || "development";

  if (
    !(["local", "production", "test"] as const).includes(
      appEnvironment as DashboardEnvironment["APP_ENV"],
    )
  ) {
    throw new Error("APP_ENV must be local, production or test");
  }
  if (
    !(["development", "production", "test"] as const).includes(
      nodeEnvironment as DashboardEnvironment["NODE_ENV"],
    )
  ) {
    throw new Error("NODE_ENV must be development, production or test");
  }
  if (
    (appEnvironment === "production") !==
    (nodeEnvironment === "production")
  ) {
    throw new Error("APP_ENV and NODE_ENV disagree");
  }

  return {
    ...environment,
    APP_ENV: appEnvironment as DashboardEnvironment["APP_ENV"],
    NODE_ENV: nodeEnvironment as DashboardEnvironment["NODE_ENV"],
  };
};

export const loadDashboardEnvironment = (
  injectedEnvironment: Record<string, string | undefined>,
  directory: string,
): DashboardEnvironment => {
  const profile = validateProfile(injectedEnvironment);
  if (profile.APP_ENV !== "local") return profile;

  const path = join(directory, ".env.local");
  const localEnvironment = existsSync(path)
    ? parseEnv(readFileSync(path, "utf8"))
    : {};

  return validateProfile({ ...localEnvironment, ...injectedEnvironment });
};
