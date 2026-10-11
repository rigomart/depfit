import { Hono } from "hono";
import { z } from "zod";

export const app = new Hono();
export const Id = z.string();
