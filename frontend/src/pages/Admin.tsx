import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Layout } from "../components/Layout";
import { useAuth } from "../context/AuthContext";
import * as api from "../api";
import { getPasswordPolicy, validatePassword } from "../utils/passwordPolicy";
import { AccessControlCard } from "./admin/AccessControlCard";
import { AdminHeader, AdminStatusMessages } from "./admin/AdminShell";
import { CreateUserForm } from "./admin/CreateUserForm";
import { GuestAccessCard } from "./admin/GuestAccessCard";
import { LoginRateLimitCard } from "./admin/LoginRateLimitCard";
import { UserActionModals } from "./admin/UserActionModals";
import { UsersTable } from "./admin/UsersTable";
import { AgentsTable, type AdminApiKey } from "./admin/AgentsTable";
import type { AdminTab } from "./admin/AdminTabsHeader";
import type { AdminUser } from "./admin/types";
import { getCreateUserOutcome, type CreateUserResponse } from "./admin/createUserOutcome";
import { useAccessControlSettings } from "./admin/useAccessControlSettings";
import { useAdminCollections } from "./admin/useAdminCollections";
import { useGuestAccessSettings } from "./admin/useGuestAccessSettings";
import { useLoginRateLimitSettings } from "./admin/useLoginRateLimitSettings";
import {
  IMPERSONATION_KEY,
  type ImpersonationState,
  readImpersonationState,
  USER_KEY,
} from "../utils/impersonation";
export const Admin: React.FC = () => {
  const navigate = useNavigate();
  const { user: authUser, authEnabled, passwordResetEnabled } = useAuth();
  const isAdmin = authUser?.role === "ADMIN";
  const passwordPolicy = getPasswordPolicy();
  const {
    collections,
    loadCollections,
    handleSelectCollection,
    handleCreateCollection,
    handleEditCollection,
    handleDeleteCollection,
  } = useAdminCollections(navigate);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [adminTab, setAdminTab] = useState<AdminTab>("users");
  const [apiKeys, setApiKeys] = useState<AdminApiKey[]>([]);
  const [loadingApiKeys, setLoadingApiKeys] = useState(false);
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createName, setCreateName] = useState("");
  const [createUsername, setCreateUsername] = useState("");
  const [createSendInvite, setCreateSendInvite] = useState(true);
  const [createPassword, setCreatePassword] = useState("");
  const [createOidcOnly, setCreateOidcOnly] = useState(false);
  const [createRole, setCreateRole] = useState<"ADMIN" | "USER">("USER");
  const [createMustReset, setCreateMustReset] = useState(true);
  const [createActive, setCreateActive] = useState(true);
  const [impersonateTarget, setImpersonateTarget] = useState<AdminUser | null>(null);
  const [resetPasswordLoadingId, setResetPasswordLoadingId] = useState<string | null>(null);
  const [resetPasswordResult, setResetPasswordResult] = useState<{
    email: string;
    tempPassword: string;
  } | null>(null);
  const [offboardUserId, setOffboardUserId] = useState("");
  const [offboardDestination, setOffboardDestination] = useState("company-archive");
  const [offboardConfirmation, setOffboardConfirmation] = useState("");
  const [offboarding, setOffboarding] = useState(false);
  const accessControl = useAccessControlSettings(isAdmin, setError, setSuccess);
  const guestAccess = useGuestAccessSettings(isAdmin, setError, setSuccess);
  const loginRateLimit = useLoginRateLimitSettings({
    authEnabled,
    isAdmin,
    setError,
    setSuccess,
  });
  useEffect(() => {
    if (authEnabled === false) {
      navigate("/settings", { replace: true });
      return;
    }
    if (authEnabled && !isAdmin) {
      navigate("/", { replace: true });
      return;
    }
  }, [authEnabled, isAdmin, navigate]);
  // Agents are fetched when the tab is first opened, not on every admin visit.
  useEffect(() => {
    if (adminTab === "agents" && apiKeys.length === 0 && !loadingApiKeys) {
      void loadApiKeys();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminTab]);

  const loadApiKeys = async () => {
    setLoadingApiKeys(true);
    try {
      const response = await api.api.get<{ apiKeys: AdminApiKey[] }>("/auth/users/api-keys");
      setApiKeys(response.data.apiKeys || []);
    } catch {
      setError("Failed to load agents");
    } finally {
      setLoadingApiKeys(false);
    }
  };

  const revokeApiKey = async (key: AdminApiKey) => {
    setRevokingKeyId(key.id);
    try {
      await api.api.delete(`/auth/users/api-keys/${key.id}`);
      // Revoked keys stay listed on purpose, so the record remains visible.
      setApiKeys((prev) =>
        prev.map((entry) =>
          entry.id === key.id ? { ...entry, revokedAt: new Date().toISOString() } : entry,
        ),
      );
      setSuccess(`Agent "${key.name}" revoked`);
    } catch {
      setError("Failed to revoke agent");
    } finally {
      setRevokingKeyId(null);
    }
  };

  const loadUsers = async () => {
    setLoadingUsers(true);
    setError("");
    try {
      const response = await api.api.get<{ users: AdminUser[] }>("/auth/users");
      setUsers(response.data.users || []);
    } catch (err: unknown) {
      let message = "Failed to load users";
      if (api.isAxiosError(err)) {
        message = err.response?.data?.message || err.response?.data?.error || message;
      }
      setError(message);
    } finally {
      setLoadingUsers(false);
    }
  };
  const generateTempPassword = async (target: AdminUser) => {
    setResetPasswordLoadingId(target.id);
    setError("");
    setSuccess("");
    try {
      const response = await api.api.post<{
        tempPassword: string;
        user: { id: string; email: string };
      }>(`/auth/users/${target.id}/reset-password`);
      setResetPasswordResult({
        email: response.data.user?.email || target.email,
        tempPassword: response.data.tempPassword,
      });
      setSuccess(`Temporary password generated for ${target.email}`);
      await loadUsers();
    } catch (err: unknown) {
      let message = "Failed to reset password";
      if (api.isAxiosError(err)) {
        message = err.response?.data?.message || err.response?.data?.error || message;
      }
      setError(message);
    } finally {
      setResetPasswordLoadingId(null);
    }
  };
  useEffect(() => {
    if (!authEnabled || !isAdmin) return;
    void loadCollections();
    void loadUsers();
    void accessControl.load();
    void guestAccess.load();
  }, [authEnabled, isAdmin]);
  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    const willInvite = passwordResetEnabled && createSendInvite && !createOidcOnly;
    // An invited user picks their own password; the server generates a
    // throwaway so the account still has a valid hash.
    const passwordError =
      createOidcOnly || willInvite ? null : validatePassword(createPassword, passwordPolicy);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    try {
      const payload = {
        email: createEmail.trim().toLowerCase(),
        name: createName.trim(),
        username: createUsername.trim() ? createUsername.trim() : undefined,
        password: createOidcOnly || willInvite ? undefined : createPassword,
        oidcOnly: createOidcOnly,
        role: createRole,
        mustResetPassword: createOidcOnly ? false : createMustReset,
        isActive: createActive,
        sendInvite: willInvite,
      };
      const response = await api.api.post<CreateUserResponse>("/auth/users", payload);
      setUsers((prev) =>
        [...prev, response.data.user].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
      const outcome = getCreateUserOutcome(response.data);
      setSuccess(outcome.success ?? "");
      setError(outcome.error ?? "");
      if (outcome.temporaryPassword) {
        setResetPasswordResult({
          email: response.data.user.email,
          tempPassword: outcome.temporaryPassword,
        });
      }
      setCreateEmail("");
      setCreateName("");
      setCreateUsername("");
      setCreatePassword("");
      setCreateOidcOnly(false);
      setCreateRole("USER");
      setCreateMustReset(true);
      setCreateActive(true);
      setCreateOpen(false);
    } catch (err: unknown) {
      let message = "Failed to create user";
      if (api.isAxiosError(err)) {
        message = err.response?.data?.message || err.response?.data?.error || message;
      }
      setError(message);
    }
  };
  const patchUser = async (
    id: string,
    data: Partial<Pick<AdminUser, "username" | "name" | "role" | "mustResetPassword" | "isActive">>,
  ) => {
    setError("");
    setSuccess("");
    try {
      const response = await api.api.patch<{ user: AdminUser }>(`/auth/users/${id}`, data);
      setUsers((prev) => prev.map((u) => (u.id === id ? response.data.user : u)));
      setSuccess("User updated");
    } catch (err: unknown) {
      let message = "Failed to update user";
      if (api.isAxiosError(err)) {
        message = err.response?.data?.message || err.response?.data?.error || message;
      }
      setError(message);
    }
  };
  const offboardUser = async (event: React.FormEvent) => {
    event.preventDefault();
    const target = users.find((candidate) => candidate.id === offboardUserId);
    if (!target || offboardConfirmation !== target.email) {
      setError("Enter the user's exact email address to confirm deletion.");
      return;
    }
    setOffboarding(true);
    setError("");
    setSuccess("");
    try {
      const body =
        offboardDestination === "company-archive"
          ? { transferTo: "company-archive" }
          : { transferToUserId: offboardDestination };
      const response = await api.api.post<{
        deleted: true;
        transferredDrawings: number;
      }>(`/auth/users/${target.id}/offboard`, body);
      setUsers((current) => current.filter((user) => user.id !== target.id));
      setOffboardUserId("");
      setOffboardDestination("company-archive");
      setOffboardConfirmation("");
      setSuccess(
        `Personal data deleted; ${response.data.transferredDrawings} board(s) transferred.`,
      );
    } catch (err: unknown) {
      let message = "Failed to permanently delete user data";
      if (api.isAxiosError(err)) {
        message = err.response?.data?.message || err.response?.data?.error || message;
      }
      setError(message);
    } finally {
      setOffboarding(false);
    }
  };
  const startImpersonation = async (target: AdminUser) => {
    setError("");
    setSuccess("");
    if (readImpersonationState()) {
      setError("Stop the current impersonation before starting a new one.");
      return;
    }
    const originalUser = localStorage.getItem(USER_KEY);
    if (!originalUser) {
      setError("Missing current session user state.");
      return;
    }
    try {
      const response = await api.api.post<{
        user: { id: string; email: string; name: string };
      }>("/auth/impersonate", { userId: target.id });
      const state: ImpersonationState = {
        original: { user: JSON.parse(originalUser) },
        impersonator: {
          id: authUser?.id || "unknown",
          email: authUser?.email || "unknown",
          name: authUser?.name || "Unknown Admin",
        },
        target: {
          id: response.data.user.id,
          email: response.data.user.email,
          name: response.data.user.name,
        },
        startedAt: new Date().toISOString(),
      };
      localStorage.setItem(IMPERSONATION_KEY, JSON.stringify(state));
      localStorage.setItem(USER_KEY, JSON.stringify(response.data.user));
      window.location.href = "/";
    } catch (err: unknown) {
      let message = "Failed to impersonate user";
      if (api.isAxiosError(err)) {
        message = err.response?.data?.message || err.response?.data?.error || message;
      }
      setError(message);
    }
  };
  if (authEnabled === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        {" "}
        <div className="text-gray-600 dark:text-gray-400">Loading...</div>{" "}
      </div>
    );
  }
  return (
    <Layout
      collections={collections}
      selectedCollectionId="ADMIN"
      onSelectCollection={handleSelectCollection}
      onCreateCollection={handleCreateCollection}
      onEditCollection={handleEditCollection}
      onDeleteCollection={handleDeleteCollection}
    >
      {" "}
      <AdminHeader
        loadingUsers={loadingUsers}
        onRefreshUsers={loadUsers}
        onToggleCreateUser={() => setCreateOpen((value) => !value)}
      />{" "}
      <AdminStatusMessages success={success} error={error} />{" "}
      {createOpen && (
        <CreateUserForm
          email={createEmail}
          name={createName}
          username={createUsername}
          password={createPassword}
          oidcOnly={createOidcOnly}
          oidcEnabled={accessControl.oidcEnabled}
          role={createRole}
          mustReset={createMustReset}
          sendInvite={createSendInvite}
          mailEnabled={passwordResetEnabled}
          active={createActive}
          passwordPolicy={passwordPolicy}
          onSubmit={handleCreateUser}
          onCancel={() => setCreateOpen(false)}
          onEmailChange={setCreateEmail}
          onNameChange={setCreateName}
          onUsernameChange={setCreateUsername}
          onPasswordChange={setCreatePassword}
          onOidcOnlyChange={setCreateOidcOnly}
          onRoleChange={setCreateRole}
          onMustResetChange={setCreateMustReset}
          onSendInviteChange={setCreateSendInvite}
          onActiveChange={setCreateActive}
        />
      )}{" "}
      <AccessControlCard
        registrationEnabled={accessControl.registrationEnabled}
        localRegistrationAllowed={accessControl.localRegistrationAllowed}
        oidcEnabled={accessControl.oidcEnabled}
        oidcProviderName={accessControl.oidcProviderName}
        oidcJitProvisioningEnabled={accessControl.oidcJitProvisioningEnabled}
        loading={accessControl.loading}
        onToggleRegistration={accessControl.toggleRegistration}
        onToggleOidcJitProvisioning={accessControl.toggleOidcJitProvisioning}
      />{" "}
      <GuestAccessCard
        uploadFiles={guestAccess.capabilities?.uploadFiles ?? null}
        viewComments={guestAccess.capabilities?.viewComments ?? null}
        agentContextContribute={guestAccess.capabilities?.agentContextContribute ?? null}
        loading={guestAccess.loading}
        onToggleUploadFiles={guestAccess.toggleUploadFiles}
        onToggleViewComments={guestAccess.toggleViewComments}
        onToggleAgentContextContribute={guestAccess.toggleAgentContextContribute}
      />{" "}
      <LoginRateLimitCard
        loading={loginRateLimit.loading}
        saving={loginRateLimit.saving}
        autoSaveQueued={loginRateLimit.autoSaveQueued}
        dirty={loginRateLimit.dirty}
        enabled={loginRateLimit.enabled}
        windowMinutes={loginRateLimit.windowMinutes}
        maxAttempts={loginRateLimit.maxAttempts}
        resetIdentifier={loginRateLimit.resetIdentifier}
        resetLoading={loginRateLimit.resetLoading}
        userEmails={users.map((user) => user.email)}
        onToggleEnabled={() => loginRateLimit.setEnabled(!loginRateLimit.enabled)}
        onWindowMinutesChange={loginRateLimit.setWindowMinutes}
        onMaxAttemptsChange={loginRateLimit.setMaxAttempts}
        onResetIdentifierChange={loginRateLimit.setResetIdentifier}
        onReset={loginRateLimit.reset}
      />{" "}
      {adminTab === "agents" ? (
        <AgentsTable
          apiKeys={apiKeys}
          loading={loadingApiKeys}
          revokingId={revokingKeyId}
          activeTab={adminTab}
          onTabChange={setAdminTab}
          onRevoke={revokeApiKey}
        />
      ) : (
        <UsersTable
          activeTab={adminTab}
          onTabChange={setAdminTab}
          users={users}
          loading={loadingUsers}
          currentUserId={authUser?.id}
          resetPasswordLoadingId={resetPasswordLoadingId}
          onRoleChange={(user, role) => patchUser(user.id, { role })}
          onToggleActive={(user) => patchUser(user.id, { isActive: !user.isActive })}
          onToggleMustReset={(user) =>
            patchUser(user.id, { mustResetPassword: !user.mustResetPassword })
          }
          onImpersonate={setImpersonateTarget}
          onResetPassword={generateTempPassword}
        />
      )}{" "}
      {adminTab === "users" && (
        <form
          onSubmit={offboardUser}
          className="mt-6 bg-white dark:bg-neutral-900 border-2 border-red-700 dark:border-red-500 rounded-2xl p-5 sm:p-6 shadow-[4px_4px_0px_0px_rgba(185,28,28,1)]"
        >
          <h2 className="text-lg font-black text-red-800 dark:text-red-300">
            Permanent user offboarding
          </h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-neutral-300">
            This removes the person's name, email, login identities, credentials, API keys, personal
            library and related audit data. Boards and documents are transferred to the destination
            below. This is separate from making an account inactive and cannot be undone.
          </p>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <label className="text-sm font-bold text-slate-800 dark:text-neutral-200">
              User to delete
              <select
                value={offboardUserId}
                onChange={(event) => {
                  setOffboardUserId(event.target.value);
                  setOffboardDestination("company-archive");
                  setOffboardConfirmation("");
                }}
                className="mt-1 w-full px-3 py-2 bg-white dark:bg-neutral-800 border-2 border-slate-300 dark:border-neutral-700 rounded-xl"
              >
                <option value="">Choose a user…</option>
                {users
                  .filter((user) => user.id !== authUser?.id)
                  .map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name} ({user.email})
                    </option>
                  ))}
              </select>
            </label>
            <label className="text-sm font-bold text-slate-800 dark:text-neutral-200">
              Transfer boards to
              <select
                value={offboardDestination}
                onChange={(event) => setOffboardDestination(event.target.value)}
                disabled={!offboardUserId}
                className="mt-1 w-full px-3 py-2 bg-white dark:bg-neutral-800 border-2 border-slate-300 dark:border-neutral-700 rounded-xl disabled:opacity-60"
              >
                <option value="company-archive">Company archive account</option>
                {users
                  .filter((user) => user.id !== offboardUserId && user.isActive)
                  .map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name} ({user.email})
                    </option>
                  ))}
              </select>
            </label>
            <label className="text-sm font-bold text-slate-800 dark:text-neutral-200">
              Confirm with exact email
              <input
                value={offboardConfirmation}
                onChange={(event) => setOffboardConfirmation(event.target.value)}
                disabled={!offboardUserId}
                autoComplete="off"
                className="mt-1 w-full px-3 py-2 bg-white dark:bg-neutral-800 border-2 border-slate-300 dark:border-neutral-700 rounded-xl disabled:opacity-60"
                placeholder={
                  users.find((user) => user.id === offboardUserId)?.email || "user@example.com"
                }
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={
              offboarding ||
              !offboardUserId ||
              offboardConfirmation !== users.find((user) => user.id === offboardUserId)?.email
            }
            className="mt-4 px-4 py-2 rounded-xl border-2 border-red-800 bg-red-700 text-white font-black disabled:opacity-50"
          >
            {offboarding ? "Deleting personal data…" : "Delete personal data"}
          </button>
        </form>
      )}{" "}
      <UserActionModals
        impersonateTarget={impersonateTarget}
        resetPasswordResult={resetPasswordResult}
        onConfirmImpersonation={startImpersonation}
        onCancelImpersonation={() => setImpersonateTarget(null)}
        onCopyPassword={(result) => navigator.clipboard?.writeText(result.tempPassword)}
        onClosePassword={() => setResetPasswordResult(null)}
      />{" "}
    </Layout>
  );
};
