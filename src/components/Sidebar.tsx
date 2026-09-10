"use no memo";
import { AppShellSection, Group, Stack, Tooltip } from "@mantine/core";
import {
  type Icon,
  IconChess,
  IconCpu,
  IconDatabase,
  IconFiles,
  IconSettings,
  IconUser,
} from "@tabler/icons-react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import cx from "clsx";
import { useTranslation } from "react-i18next";
import classes from "./Sidebar.module.css";

interface NavbarLinkProps {
  icon: Icon;
  label: string;
  url: string;
  active?: boolean;
  horizontal?: boolean;
}

function NavbarLink({ url, icon: Icon, label, horizontal }: NavbarLinkProps) {
  const match = useMatchRoute();
  const active = match({ to: url, fuzzy: true }) !== false;
  const link = (
    <Link
      to={url}
      aria-label={label}
      className={cx(classes.link, {
        [classes.horizontal]: horizontal,
        [classes.active]: active && !horizontal,
        [classes.activeHorizontal]: active && horizontal,
      })}
    >
      <Icon size="1.5rem" stroke={1.5} />
    </Link>
  );
  // A tooltip needs a hover, which a touch device has no way to produce, and it
  // would sit off the top of the screen from a bottom bar. aria-label carries the
  // name instead.
  return horizontal ? (
    link
  ) : (
    <Tooltip label={label} position="right">
      {link}
    </Tooltip>
  );
}

const linksdata = [
  { icon: IconChess, label: "Board", url: "/" },
  { icon: IconUser, label: "User", url: "/accounts" },
  { icon: IconFiles, label: "Files", url: "/files" },
  {
    icon: IconDatabase,
    label: "Databases",
    url: "/databases",
  },
  { icon: IconCpu, label: "Engines", url: "/engines" },
];

export function SideBar({ orientation = "vertical" }: { orientation?: "vertical" | "horizontal" }) {
  const { t } = useTranslation();

  const links = linksdata.map((link) => (
    <NavbarLink
      {...link}
      label={t(`SideBar.${link.label}`)}
      key={link.label}
      horizontal={orientation === "horizontal"}
    />
  ));

  // Bottom bar: one row, settings alongside the rest rather than pinned to an end.
  if (orientation === "horizontal") {
    return (
      <Group h="100%" justify="space-around" gap={0} wrap="nowrap">
        {links}
        <NavbarLink icon={IconSettings} label={t("SideBar.Settings")} url="/settings" horizontal />
      </Group>
    );
  }

  return (
    <>
      <AppShellSection grow>
        <Stack justify="center" gap={0}>
          {links}
        </Stack>
      </AppShellSection>
      <AppShellSection>
        <Stack justify="center" gap={0}>
          <NavbarLink icon={IconSettings} label={t("SideBar.Settings")} url="/settings" />
        </Stack>
      </AppShellSection>
    </>
  );
}
