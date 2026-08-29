// Vercel Speed Insights initialization
// This script injects Speed Insights tracking for performance monitoring
import { injectSpeedInsights } from '../../node_modules/@vercel/speed-insights/dist/index.mjs';

// Initialize Speed Insights with default configuration
injectSpeedInsights();
