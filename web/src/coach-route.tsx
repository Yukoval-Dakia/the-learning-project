import { lazyRouteComponent, useRouter } from '@tanstack/react-router';
import { loadCoachHub } from '@/capabilities/shell/ui-public';

// Dev SPA only. Production /coach is the Start route, which injects the same badge.
export const LazyCoachRoute = lazyRouteComponent(async () => {
  const CoachHub = await loadCoachHub();
  const { getCalibrationMaturity, renderCalibrationMaturityBadge } = await import(
    '@/capabilities/onboarding/ui-public'
  );

  function CoachRoute() {
    const router = useRouter();
    return (
      <CoachHub
        navigate={(to) => router.history.push(to)}
        readCalibration={getCalibrationMaturity}
        maturityBadge={renderCalibrationMaturityBadge}
      />
    );
  }

  return { default: CoachRoute };
});
