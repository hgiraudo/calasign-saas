import { lazy, Suspense, type ComponentType } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { RequireAuth } from "./lib/auth";
import { AccessProvider, RequirePermission } from "./lib/access";
import { Spinner } from "./components/ui";

/**
 * Cada página se carga aparte (import dinámico): antes toda la app (consola, firmante, formularios públicos, editor,
 * ajustes) iba en un único archivo de ~1,7 MB que el firmante bajaba entero desde el celular para ver un sobre.
 * Lo compartido (React, i18n, cliente de la API) queda en el archivo de entrada; Rollup agrupa lo que comparten varias
 * páginas. Un trozo que ya no existe tras un deploy recarga la página (vite:preloadError en main.tsx) o, si persiste,
 * muestra RouteError.
 */
function page<K extends string, M extends Record<K, ComponentType<any>>>(load: () => Promise<M>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}

const AiSettingsPage = page(() => import("./pages/AiSettings"), "AiSettingsPage");
const LoginPage = page(() => import("./pages/Auth"), "LoginPage");
const SignupPage = page(() => import("./pages/Auth"), "SignupPage");
const ForgotPasswordPage = page(() => import("./pages/Password"), "ForgotPasswordPage");
const ResetPasswordPage = page(() => import("./pages/Password"), "ResetPasswordPage");
const EnvelopeListPage = page(() => import("./pages/EnvelopeList"), "EnvelopeListPage");
const EnvelopeEditPage = page(() => import("./pages/EnvelopeEdit"), "EnvelopeEditPage");
const EnvelopeDetailPage = page(() => import("./pages/EnvelopeDetail"), "EnvelopeDetailPage");
const ApiKeysPage = page(() => import("./pages/ApiKeys"), "ApiKeysPage");
const SignerPage = page(() => import("./pages/Signer"), "SignerPage");
const DevMailboxPage = page(() => import("./pages/DevMailbox"), "DevMailboxPage");
const IntegrationsPage = page(() => import("./pages/Integrations"), "IntegrationsPage");
const VerifyPage = page(() => import("./pages/Verify"), "VerifyPage");
const TemplatesPage = page(() => import("./pages/Templates"), "TemplatesPage");
const TemplateEditPage = page(() => import("./pages/TemplateEdit"), "TemplateEditPage");
const TemplateUsePage = page(() => import("./pages/TemplateUse"), "TemplateUsePage");
const BrandingPage = page(() => import("./pages/Branding"), "BrandingPage");
const BillingNoAccess = page(() => import("./pages/Billing"), "BillingNoAccess");
const BillingPage = page(() => import("./pages/Billing"), "BillingPage");
const TeamPage = page(() => import("./pages/Team"), "TeamPage");
const SettingsHomePage = page(() => import("./pages/SettingsHome"), "SettingsHomePage");
const CertificatesPage = page(() => import("./pages/Certificates"), "CertificatesPage");
const XmlSignPage = page(() => import("./pages/XmlSign"), "XmlSignPage");
const AuditLogPage = page(() => import("./pages/AuditLog"), "AuditLogPage");
const SecurityPage = page(() => import("./pages/Security"), "SecurityPage");
const InviteAcceptPage = page(() => import("./pages/InviteAccept"), "InviteAcceptPage");
const ReportsPage = page(() => import("./pages/Reports"), "ReportsPage");
const BulkDetailPage = page(() => import("./pages/Bulk"), "BulkDetailPage");
const BulkListPage = page(() => import("./pages/Bulk"), "BulkListPage");
const BulkNewPage = page(() => import("./pages/Bulk"), "BulkNewPage");
const WebFormDetailPage = page(() => import("./pages/WebForms"), "WebFormDetailPage");
const WebFormsPage = page(() => import("./pages/WebForms"), "WebFormsPage");
const PublicFormPage = page(() => import("./pages/PublicForm"), "PublicFormPage");
const AutomationPage = page(() => import("./pages/PlatformSettings"), "AutomationPage");
const CustomDomainPage = page(() => import("./pages/PlatformSettings"), "CustomDomainPage");
const NotificationIntegrationsPage = page(() => import("./pages/PlatformSettings"), "NotificationIntegrationsPage");
const OAuthAppsPage = page(() => import("./pages/PlatformSettings"), "OAuthAppsPage");
const StoragePage = page(() => import("./pages/PlatformSettings"), "StoragePage");
const CrmSettingsPage = page(() => import("./pages/CrmSettings"), "CrmSettingsPage");
const ConnectorsSettingsPage = page(() => import("./pages/ConnectorsSettings"), "ConnectorsSettingsPage");
const OAuthConsentPage = page(() => import("./pages/OAuthConsent"), "OAuthConsentPage");
const IdentitySettingsPage = page(() => import("./pages/IdentitySettings"), "IdentitySettingsPage");
const ScimSettingsPage = page(() => import("./pages/IdentitySettings"), "ScimSettingsPage");
const SsoSettingsPage = page(() => import("./pages/IdentitySettings"), "SsoSettingsPage");
const AgreementDetailPage = page(() => import("./pages/Agreements"), "AgreementDetailPage");
const AgreementsPage = page(() => import("./pages/Agreements"), "AgreementsPage");
const ClausesPage = page(() => import("./pages/Documents"), "ClausesPage");
const DocumentTemplateEditPage = page(() => import("./pages/Documents"), "DocumentTemplateEditPage");
const DocumentTemplatesPage = page(() => import("./pages/Documents"), "DocumentTemplatesPage");
const WorkflowEditPage = page(() => import("./pages/Workflows"), "WorkflowEditPage");
const WorkflowRunPage = page(() => import("./pages/Workflows"), "WorkflowRunPage");
const WorkflowsPage = page(() => import("./pages/Workflows"), "WorkflowsPage");
const NegotiationDetailPage = page(() => import("./pages/Negotiations"), "NegotiationDetailPage");
const NegotiationsPage = page(() => import("./pages/Negotiations"), "NegotiationsPage");
const PublicNegotiationPage = page(() => import("./pages/PublicAgreements"), "PublicNegotiationPage");
const PublicWorkflowRunPage = page(() => import("./pages/PublicAgreements"), "PublicWorkflowRunPage");
const PublicWorkflowStartPage = page(() => import("./pages/PublicAgreements"), "PublicWorkflowStartPage");
const ByokSettingsPage = page(() => import("./pages/ByokSettings"), "ByokSettingsPage");
const FirmadorPage = page(() => import("./pages/Firmador"), "FirmadorPage");

// El portal de desarrolladores es grande (textos en tres idiomas, ejemplos, referencia): se carga aparte.
const DevelopersPage = lazy(() => import("./pages/developers/DevelopersPage"));

/** Mientras llega el trozo de una página: un indicador liviano (sin la página anterior a medias). */
const fallback = <Spinner />;

export function App() {
  return (
    <Suspense fallback={fallback}>
      <Routes>
        <Route path="/" element={<Navigate to="/app" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot" element={<ForgotPasswordPage />} />
        <Route path="/reset/:token" element={<ResetPasswordPage />} />
        <Route path="/s/:token" element={<SignerPage />} />
        <Route path="/developers/*" element={<DevelopersPage />} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/firmador" element={<FirmadorPage />} />
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
          <Route path="/app/settings/api-keys" element={<ApiKeysPage />} />
          <Route path="/app/dev-mailbox" element={<DevMailboxPage />} />
          <Route path="/app/settings/integrations" element={<IntegrationsPage />} />
          <Route path="/app/templates" element={<TemplatesPage />} />
          <Route path="/app/templates/:id/edit" element={<TemplateEditPage />} />
          <Route path="/app/templates/:id/use" element={<TemplateUsePage />} />
          <Route path="/app/settings/branding" element={<BrandingPage />} />
          <Route
            path="/app/settings/billing"
            element={
              <RequirePermission perm="billing:manage" fallback={<BillingNoAccess />}>
                <BillingPage />
              </RequirePermission>
            }
          />
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
          <Route path="/app/settings/connectors" element={<ConnectorsSettingsPage />} />
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
    </Suspense>
  );
}
