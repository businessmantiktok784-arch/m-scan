import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { theme } from "@/src/theme";

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

function RootLayoutNav() {
  return (
    <Stack
      screenOptions={{
        headerBackTitle: "Back",
        headerStyle: { backgroundColor: theme.surface },
        headerTintColor: theme.text,
        headerTitleStyle: { fontWeight: "600", color: theme.text },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.bg },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="+not-found" options={{ title: "Not found" }} />
    </Stack>
  );
}

export default function RootLayout() {
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {
      // Hiding twice or too early is harmless; nothing to report.
    });
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      <RootLayoutNav />
    </GestureHandlerRootView>
  );
}
