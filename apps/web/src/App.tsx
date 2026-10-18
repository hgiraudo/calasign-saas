import { AiSettingsPage } from "./pages/AiSettings";
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
import { SignerVideoDock } from "./components/Video";
import { VideoRoomPage } from "./pages/VideoRoom";
import { DevMailboxPage } from "./pages/DevMailbox";
import { IntegrationsPage } from "./pages/Integrations";
import { DevelopersPage } from "./pages/Developers";
import { VerifyPage } from "./pages/Verify";
import { TemplatesPage } from "./pages/Templates";
import { TemplateEditPage } from "./pages/TemplateEdit";
import { TemplateUsePage } from "./pages/TemplateUse";
import { BrandingPage } from "./pages/Branding";
import { BillingPage } from "./pages/Billing";
import { TeamPage } from "./pages/Team";
import { SettingsHomePage } from "./pages/SettingsHome";
import { CertificatesPage } from "./pages/Certificates";
import { XmlSignPage } from "./pages/XmlSign";
import { AuditLogPage } from "./pages/AuditLog";
import { SecurityPage } from "./pages/Security";
import { InviteAcceptPage } from "./pages/InviteAccept";
import { ReportsPage } from "./pages/Reports";
import { BulkDetailPage, BulkListPage, BulkNewPage } from "./pages/Bulk";
import { WebFormDetailPage, WebFormsPage } from "./pages/WebForms";
import { PublicFormPage } from "./pages/PublicForm";
import { AutomationPage, CustomDomainPage, NotificationIntegrationsPage, OAuthAppsPage, StoragePage } from "./pages/PlatformSettings";
import { CrmSettingsPage } from "./pages/CrmSettings";
import { OAuthConsentPage } from "./pages/OAuthConsent";
import { IdentitySettingsPage, ScimSettingsPage, SsoSettingsPage } from "./pages/IdentitySettings";
import { AgreementDetailPage, AgreementsPage } from "./pages/Agreements";
import { ClausesPage, DocumentTemplateEditPage, DocumentTemplatesPage } from "./pages/Documents";
import { WorkflowEditPage, WorkflowRunPage, WorkflowsPage } from "./pages/Workflows";
import { NegotiationDetailPage, NegotiationsPage } from "./pages/Negotiations";
import { PublicNegotiationPage, PublicWorkflowRunPage, PublicWorkflowStartPage } from "./pages/PublicAgreements";
import { ByokSettingsPage } from "./pages/ByokSettings";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/s/:token" element={<><SignerPage /><SignerVideoDock /></>} />
      <Route path="/developers" element={<DevelopersPage />} />
      <Route path="/verify" element={<VerifyPage />} />
      <Route path="/invite/:token" element={<InviteAcceptPage />} />
      <Route path="/f/:slug" element={<PublicFormPage />} />
      <Route path="/wf/:slug" element={<PublicWorkflowStartPage />} />
      <Route path="/w/:token" element={<PublicWorkflowRunPage />} />
      <Route path="/n/:token" element={<PublicNegotiationPage />} />
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
        <Route path="/app/envelopes/:id/video/:sid" element={<VideoRoomPage />} />
        <Route path="/app/settings/api-keys" element={<ApiKeysPage />} />
        <Route path="/app/dev-mailbox" element={<DevMailboxPage />} />
        <Route path="/app/settings/integrations" element={<IntegrationsPage />} />
        <Route path="/app/templates" element={<TemplatesPage />} />
        <Route path="/app/templates/:id/edit" element={<TemplateEditPage />} />
        <Route path="/app/templates/:id/use" element={<TemplateUsePage />} />
        <Route path="/app/settings/branding" element={<BrandingPage />} />
        <Route path="/app/settings/billing" element={<BillingPage />} />
        <Route path="/app/settings" element={<SettingsHomePage />} />
        <Route path="/app/settings/certificates" element={<CertificatesPage />} />
        <Route path="/app/settings/ai" element={<AiSettingsPage />} />
        <Route path="/app/xml" element={<XmlSignPage />} />
        <Route path="/app/settings/team" element={<TeamPage />} />
        <Route path="/app/settings/audit" element={<AuditLogPage />} />
        <Route path="/app/settings/security" element={<SecurityPage />} />
        <Route path="/app/settings/identity" element={<IdentitySettingsPage />} />
        <Route path="/app/settings/sso" element={<SsoSettingsPage />} />
        <Route path="/app/settings/byok" element={<ByokSettingsPage />} />
        <Route path="/app/settings/scim" element={<ScimSettingsPage />} />
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
        <Route path="/app/settings/crm" element={<CrmSettingsPage />} />
        <Route path="/app/settings/domain" element={<CustomDomainPage />} />
        <Route path="/app/agreements" element={<AgreementsPage />} />
        <Route path="/app/agreements/:id" element={<AgreementDetailPage />} />
        <Route path="/app/documents" element={<DocumentTemplatesPage />} />
        <Route path="/app/documents/:id" element={<DocumentTemplateEditPage />} />
        <Route path="/app/clauses" element={<ClausesPage />} />
        <Route path="/app/workflows" element={<WorkflowsPage />} />
        <Route path="/app/workflows/:id" element={<WorkflowEditPage />} />
        <Route path="/app/workflow-runs/:id" element={<WorkflowRunPage />} />
        <Route path="/app/negotiations" element={<NegotiationsPage />} />
        <Route path="/app/negotiations/:id" element={<NegotiationDetailPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
