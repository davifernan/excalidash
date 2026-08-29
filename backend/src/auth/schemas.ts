import { z } from "zod";
import { buildPasswordPolicyMessage, config, validatePasswordAgainstPolicy } from "../config";

const passwordPolicyMessage = () => buildPasswordPolicyMessage(config.passwordPolicy);

const passwordSchema = z.string().superRefine((value, ctx) => {
  const validationMessage = validatePasswordAgainstPolicy(value, config.passwordPolicy);
  if (!validationMessage) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: validationMessage,
  });
});
export const registerSchema = z.object({
  username: z.string().trim().min(3).max(50).optional(),
  email: z.string().email().toLowerCase().trim(),
  password: passwordSchema,
  name: z.string().trim().min(1).max(100),
  setupCode: z.string().trim().min(1).max(64).optional(),
});

export const loginSchema = z
  .object({
    identifier: z.string().trim().min(1).max(255).optional(),
    email: z.string().email().toLowerCase().trim().optional(),
    username: z.string().trim().min(1).max(255).optional(),
    password: z.string(),
    rememberMe: z.boolean().optional(),
  })
  .refine((data) => Boolean(data.identifier || data.email || data.username), {
    message: "identifier/email/username is required",
  });

export const registrationToggleSchema = z.object({
  enabled: z.boolean(),
});

export const oidcJitProvisioningToggleSchema = z.object({
  enabled: z.boolean(),
});

export const guestCapabilityToggleSchema = z
  .object({
    uploadFiles: z.boolean().optional(),
    viewComments: z.boolean().optional(),
    agentContextContribute: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.uploadFiles !== undefined ||
      data.viewComments !== undefined ||
      data.agentContextContribute !== undefined,
    {
      message: "At least one guest capability must be provided",
    },
  );

export const adminRoleUpdateSchema = z.object({
  identifier: z.string().trim().min(1).max(255),
  role: z.enum(["ADMIN", "USER"]),
});

export const authEnabledToggleSchema = z.object({
  enabled: z.boolean(),
});

export const authOnboardingChoiceSchema = z.object({
  enableAuth: z.boolean(),
});

export const adminCreateUserSchema = z
  .object({
    username: z.string().trim().min(3).max(50).optional(),
    email: z.string().email().toLowerCase().trim(),
    password: passwordSchema.optional(),
    oidcOnly: z.boolean().optional(),
    /** Email the new user a link to choose their own password. */
    sendInvite: z.boolean().optional(),
    name: z.string().trim().min(1).max(100),
    role: z.enum(["ADMIN", "USER"]).optional(),
    mustResetPassword: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    // An invitation lets the user choose their own password, so the admin does
    // not have to invent one they would then have to pass on.
    if (!data.oidcOnly && !data.sendInvite && !data.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: passwordPolicyMessage(),
      });
    }
  });

export const adminUpdateUserSchema = z.object({
  username: z.string().trim().min(3).max(50).nullable().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  role: z.enum(["ADMIN", "USER"]).optional(),
  mustResetPassword: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const impersonateSchema = z
  .object({
    userId: z.string().trim().min(1).optional(),
    identifier: z.string().trim().min(1).optional(),
  })
  .refine((data) => Boolean(data.userId || data.identifier), {
    message: "userId/identifier is required",
  });

export const loginRateLimitUpdateSchema = z.object({
  enabled: z.boolean(),
  windowMs: z
    .number()
    .int()
    .min(10_000)
    .max(24 * 60 * 60 * 1000),
  max: z.number().int().min(1).max(10_000),
});

export const loginRateLimitResetSchema = z.object({
  identifier: z.string().trim().min(1).max(255),
});

export const passwordResetRequestSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
});

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const updateEmailSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  currentPassword: z.string().min(1).max(100),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: passwordSchema,
});

export const mustResetPasswordSchema = z.object({
  newPassword: passwordSchema,
});

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.string()).optional(),
  /**
   * Set to mint a drawing-bound agent token instead of an account-wide key
   * (NIL-382). The caller's edit access to this drawing is re-checked
   * server-side in accountApiKeyRoutes.ts -- a name here is a claim, not a
   * grant.
   */
  drawingId: z.string().trim().min(1).optional(),
  /**
   * Agent tokens only. Enforced (not advisory) upper bound of 30 days --
   * AGENT_TOKEN_MAX_TTL_MS in auth/apiKeys.ts -- so the shortest of "caller
   * asked for less" and "30 days" always wins.
   */
  expiresInDays: z.number().int().positive().max(30).optional(),
});

export const userPreferencesSchema = z
  .object({
    theme: z.enum(["light", "dark"]).optional(),
    dashboardSortField: z.enum(["name", "createdAt", "updatedAt"]).optional(),
    dashboardSortDirection: z.enum(["asc", "desc"]).optional(),
    /**
     * Which editor feature-registry entries this viewer keeps in the
     * bottom-right feature toolbar (NIL-655). Ids are validated as opaque
     * strings, not against the frontend's `EditorFeatureId` union -- the
     * frontend already drops an id it no longer recognizes, so this schema
     * does not need to change in lockstep with the registry every time a
     * feature is added or removed.
     */
    toolbarFeatureIds: z.array(z.string().min(1).max(64)).max(32).optional(),
    // Grid visibility is a person-level workspace choice, never board state.
    gridModeEnabled: z.boolean().optional(),
  })
  .strict();
