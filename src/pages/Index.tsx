import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { resolvePostAuthRoute } from "@/lib/postAuthRoute";
import Hero from "@/components/Hero";
import Features from "@/components/Features";
import HowItWorks from "@/components/HowItWorks";
import CTA from "@/components/CTA";
import Footer from "@/components/Footer";

const Index = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading || !user) return;
    let cancelled = false;
    resolvePostAuthRoute(user.id).then((route) => {
      if (!cancelled) navigate(route);
    });
    return () => {
      cancelled = true;
    };
  }, [user, loading, navigate]);


  return (
    <div className="min-h-screen bg-background">
      <Hero />
      <Features />
      <HowItWorks />
      <CTA />
      <Footer />
    </div>
  );
};

export default Index;
