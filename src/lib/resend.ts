import { Resend } from "resend";
import { env } from "./env";

declare global {
  // eslint-disable-next-line no-var
  var __resend: Resend | undefined;
}

export const resend: Resend = globalThis.__resend ?? new Resend(env().RESEND_API_KEY || "re_placeholder");
if (process.env.NODE_ENV !== "production") globalThis.__resend = resend;

export const RESEND_BATCH_SIZE = 100;
