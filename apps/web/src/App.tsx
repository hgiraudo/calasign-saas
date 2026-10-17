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
import { SettingsHomePage } from "./pages/SettingsHome";
import { AuditLogPage } from "./pages/AuditLog";
import { SecurityPage } from "./pages/Security";
import { InviteAcceptPage } from "./pages/InviteAccept";
import { ReportsPage } from "./pages/Reports";
import { BulkDetailPage, BulkListPage, BulkNewPage } from "./pages/Bulk";
import { WebFormDetailPage, WebFormsPage } from "./pages/WebForms";
import { PublicFormPage } from "./pages/PublicForm";
import { AutomationPage, CustomDomainPage, NotificationIntegrationsPage, OAuthAppsPage, StoragePage } from "./pages/PlatformSettings";
import { OAuthConsentPage } from "./pages/OAuthConsent";

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
      <Route path="/f/:slug" element={<PublicFormPage />} />
      <Route
        path="/oauth/authorize"
        element={
          <RequireAuth>
            <OAuthConsentPage />
          </RequireAuth>
        }
      />
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
        <Route path="/app/settings" element={<SettingsHomePage />} />
        <Route path="/app/settings/team" element={<TeamPage />} />
        <Route path="/app/settings/audit" element={<AuditLogPage />} />
        <Route path="/app/settings/security" element={<SecurityPage />} />
        <Route path="/app/reports" element={<ReportsPage />} />
        <Route path="/app/bulk" element={<BulkListPage />} />
        <Route path="/app/bulk/new" element={<BulkNewPage />} />
        <Route path="/app/bulk/:id" element={<BulkDetailPage />} />
        <Route path="/app/forms" element={<WebFormsPage />} />
        <Route path="/app/forms/:id" element={<WebFormDetailPage />} />
        <Route path="/app/settings/oauth-apps" element={<OAuthAppsPage />} />
        <Route path="/app/settings/notifications" element={<NotificationIntegrationsPage />} />
        <Route path="/app/settings/automation" element={<AutomationPage />} />
        <Route path="/app/settings/storage" element={<StoragePage />} />
        <Route path="/app/settings/domain" element={<CustomDomainPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
