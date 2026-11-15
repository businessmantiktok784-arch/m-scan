import { Tabs } from "expo-router";
import { Download, FolderKanban, Radar, ScanSearch } from "lucide-react-native";
import React from "react";

import { theme } from "@/src/theme";

const ICON = { size: 22 } as const;

/** Four principal screens, per the Stage 1 navigation specification. */
export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.amber,
        tabBarInactiveTintColor: theme.textFaint,
        tabBarStyle: {
          backgroundColor: theme.surface,
          borderTopColor: theme.outline,
        },
        sceneStyle: { backgroundColor: theme.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Projects",
          tabBarIcon: ({ color }) => <FolderKanban color={color} {...ICON} />,
        }}
      />
      <Tabs.Screen
        name="scan"
        options={{
          title: "Live Scan",
          tabBarIcon: ({ color }) => <Radar color={color} {...ICON} />,
        }}
      />
      <Tabs.Screen
        name="review"
        options={{
          title: "Review",
          tabBarIcon: ({ color }) => <ScanSearch color={color} {...ICON} />,
        }}
      />
      <Tabs.Screen
        name="export"
        options={{
          title: "Media & Export",
          tabBarIcon: ({ color }) => <Download color={color} {...ICON} />,
        }}
      />
    </Tabs>
  );
}
