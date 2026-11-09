"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type DemoRole = "admin" | "teacher" | "student";

export type DemoAccount = {
  role: DemoRole;
  username: string;
  displayNameTh: string;
  displayNameEn: string;
  passwordHint: string;
};

export const DEMO_ACCOUNTS: Record<DemoRole, DemoAccount> = {
  admin: {
    role: "admin",
    username: "admin_demo",
    displayNameTh: "ฝ่ายวิชาการ (Academic Admin)",
    displayNameEn: "Academic Admin",
    passwordHint: "demo1234",
  },
  teacher: {
    role: "teacher",
    username: "teacher_demo",
    displayNameTh: "อาจารย์ (Teacher)",
    displayNameEn: "Teacher",
    passwordHint: "demo1234",
  },
  student: {
    role: "student",
    username: "student_demo",
    displayNameTh: "นักเรียน (Student)",
    displayNameEn: "Student",
    passwordHint: "demo1234",
  },
};

export type DemoPermissions = {
  canUpload: boolean;
  canEditSchedule: boolean;
  canRunAgent: boolean;
  canRunBenchmark: boolean;
  canExport: boolean;
  canUpdateAvailability: boolean;
  forcedView: "student" | null;
};

function permissionsFor(role: DemoRole): DemoPermissions {
  switch (role) {
    case "admin":
      return {
        canUpload: true,
        canEditSchedule: true,
        canRunAgent: true,
        canRunBenchmark: true,
        canExport: true,
        canUpdateAvailability: true,
        forcedView: null,
      };
    case "teacher":
      return {
        canUpload: false,
        canEditSchedule: false,
        canRunAgent: false,
        canRunBenchmark: false,
        canExport: true,
        canUpdateAvailability: true,
        forcedView: null,
      };
    case "student":
      return {
        canUpload: false,
        canEditSchedule: false,
        canRunAgent: false,
        canRunBenchmark: false,
        canExport: true,
        canUpdateAvailability: false,
        forcedView: "student",
      };
  }
}

type DemoAuthContextValue = {
  role: DemoRole;
  account: DemoAccount;
  permissions: DemoPermissions;
  setRole: (role: DemoRole) => void;
};

const DemoAuthContext = createContext<DemoAuthContextValue | null>(null);

export function DemoAuthProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<DemoRole>("admin");

  const setRole = useCallback((next: DemoRole) => {
    setRoleState(next);
  }, []);

  const value = useMemo<DemoAuthContextValue>(() => {
    const account = DEMO_ACCOUNTS[role];
    return {
      role,
      account,
      permissions: permissionsFor(role),
      setRole,
    };
  }, [role, setRole]);

  return (
    <DemoAuthContext.Provider value={value}>{children}</DemoAuthContext.Provider>
  );
}

export function useDemoAuth(): DemoAuthContextValue {
  const ctx = useContext(DemoAuthContext);
  if (!ctx) {
    throw new Error("useDemoAuth must be used within DemoAuthProvider");
  }
  return ctx;
}
