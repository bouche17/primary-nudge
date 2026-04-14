import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { useEffect } from "react";
import Index from "./pages/Index";
import Signup from "./pages/Signup";
import Login from "./pages/Login";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import Onboarding from "./pages/Onboarding";
import Dashboard from "./pages/Dashboard";
import SettingsPage from "./pages/Settings";
import Privacy from "./pages/Privacy";
import BotFlows from "./pages/BotFlows";
import CalendarFeeds from "./pages/CalendarFeeds";
import SchoolReminders from "./pages/SchoolReminders";
import AcceptInvite from "./pages/AcceptInvite";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

/** Redirects newly-authenticated users to /invite/:token when a pending invite exists */
const PendingInviteRedirector = ({ children }: { children: React.ReactNode }) => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (loading || !user) return;
    // Don't redirect if already on the invite page
    if (location.pathname.startsWith("/invite/")) return;

    const pendingToken = localStorage.getItem("pending_invite_token");
    if (pendingToken) {
      console.log("[PendingInviteRedirector] Found pending token, redirecting to /invite/" + pendingToken);
      navigate(`/invite/${pendingToken}`, { replace: true });
    }
  }, [user, loading, location.pathname, navigate]);

  return <>{children}</>;
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <PendingInviteRedirector>
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/signup" element={<Signup />} />
              <Route path="/login" element={<Login />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/onboarding" element={<Onboarding />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/bot-flows" element={<BotFlows />} />
              <Route path="/school-reminders" element={<SchoolReminders />} />
              <Route path="/calendar-feeds" element={<CalendarFeeds />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/invite/:token" element={<AcceptInvite />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </PendingInviteRedirector>
        </BrowserRouter>
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
