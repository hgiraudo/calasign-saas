import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { RequireAuth } from "./lib/auth";
import { AccessProvider } from "./lib/access";
import { LoginPage, SignupPage } from "./pages/Auth";
import { EnvelopeListPage } from "./pages/EnvelopeList";
import { EnvelopeEditPage } from "./pages/EnvelopeEdit";
import { EnvelopeDetailPage } from "./pages/EnvelopeDetail";
import { ApiKeysPage } from "./pages/ApiKeys";
import { SignerPage } from "./pages/Signer";
import { DevMailboxPage } from "./pages/DevMailbox";
import { IntegrationsPage } from "./pages/Integrations";
import { DevelopersPage } from "./pages/Developers";
import { VerifyPage } from "./pages/Verify";
import { TemplatesPage } from "./pages/Templates";
import { TemplateEditPage } from "./pages/TemplateEdit";
import { TemplateUsePage } from "./pages/TemplateUse";
import { BrandingPage } from "./pages/Branding";
import { TeamPage } from "./pages/Team";
import { AuditLogPage } from "./pages/AuditLog";
import { SecurityPage } from "./pages/Security";
import { InviteAcceptPage } from "./pages/InviteAccept";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/s/:token" element={<SignerPage />} />
      <Route path="/developers" element={<DevelopersPage />} />
      <Route path="/verify" element={<VerifyPage />} />
      <Route path="/invite/:token" element={<InviteAcceptPage />} />
      <Route
        element={
          <RequireAuth>
            <AccessProvider>
              <Layout />
            </AccessProvider>
          </RequireAuth>
        }
      >
        <Route path="/app" element={<EnvelopeListPage />} />
        <Route path="/app/envelopes/:id" element={<EnvelopeDetailPage />} />
        <Route path="/app/envelopes/:id/edit" element={<EnvelopeEditPage />} />
        <Route path="/app/settings/api-keys" element={<ApiKeysPage />} />
        <Route path="/app/dev-mailbox" element={<DevMailboxPage />} />
        <Route path="/app/settings/integrations" element={<IntegrationsPage />} />
        <Route path="/app/templates" element={<TemplatesPage />} />
        <Route path="/app/templates/:id/edit" element={<TemplateEditPage />} />
        <Route path="/app/templates/:id/use" element={<TemplateUsePage />} />
        <Route path="/app/settings/branding" element={<BrandingPage />} />
        <Route path="/app/settings/team" element={<TeamPage />} />
        <Route path="/app/settings/audit" element={<AuditLogPage />} />
        <Route path="/app/settings/security" element={<SecurityPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
