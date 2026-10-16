import {
  ActionIcon,
  Badge,
  Card,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowDownRight,
  IconArrowRight,
  IconArrowUpRight,
  IconCircleCheckFilled,
  IconDownload,
  type IconProps,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { useAtom } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DatabaseInfo } from "@/bindings";
import { events } from "@/bindings";
import { storedDatabasesDirAtom } from "@/state/atoms";
import { syncAccountGames } from "@/utils/accountSync";
import { getDatabases } from "@/utils/db";
import { capitalize } from "@/utils/format";
import LichessLogo from "./LichessLogo";

interface AccountCardProps {
  type: "lichess" | "chesscom";
  database: DatabaseInfo | null;
  title: string;
  updatedAt: number;
  total: number;
  stats: {
    value: number;
    label: string;
    diff?: number;
  }[];
  logout: () => void;
  reload: () => void;
  setDatabases: (databases: DatabaseInfo[]) => void;
  token?: string;
}

export function AccountCard({
  type,
  database,
  title,
  updatedAt,
  total,
  stats,
  logout,
  reload,
  setDatabases,
  token,
}: AccountCardProps) {
  const { t } = useTranslation();
  const items = stats.map((stat) => {
    let color = "gray.5";
    let DiffIcon: React.FC<IconProps> = IconArrowRight;
    if (stat.diff) {
      const sign = Math.sign(stat.diff);
      if (sign === 1) {
        DiffIcon = IconArrowUpRight;
        color = "green";
      } else {
        DiffIcon = IconArrowDownRight;
        color = "red";
      }
    }
    return (
      <Group key={stat.label} justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed" fw={700} tt="uppercase">
          {capitalize(stat.label)}
        </Text>
        <Group gap={4}>
          {stat.diff !== undefined && stat.diff !== 0 && (
            <Badge color={color} variant="light" size="xs" leftSection={<DiffIcon size="0.8rem" />}>
              {Math.abs(stat.diff)}
            </Badge>
          )}
          <Text fw={700} size="sm">
            {stat.value}
          </Text>
        </Group>
      </Group>
    );
  });
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [databaseDir] = useAtom(storedDatabasesDirAtom);

  useEffect(() => {
    const unlisten = events.progressEvent.listen(async (e) => {
      if (e.payload.id === `${type}_${title}`) {
        setProgress(e.payload.progress);
        if (e.payload.finished) {
          setLoading(false);
          setDatabases(await getDatabases());
        } else {
          setLoading(true);
        }
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [setDatabases]);

  const downloadedGames = database?.type === "success" ? database.game_count : 0;
  const effectiveTotal = Math.max(total, downloadedGames);
  const percentage =
    effectiveTotal === 0 ? "0.00" : ((downloadedGames / effectiveTotal) * 100).toFixed(2);

  return (
    <Card withBorder radius="md" padding="lg">
      <Card.Section withBorder inheritPadding py="xs">
        <Group justify="space-between">
          <Group>
            {type === "lichess" ? (
              <LichessLogo />
            ) : (
              <img width={30} height={30} src="/chesscom.png" alt="chess.com" />
            )}
            <Text fw={600} size="sm">
              {title}
            </Text>
            {type === "lichess" && token && (
              <Tooltip label={t("Home.Accounts.Authenticated")}>
                <Text c="green" lh={0} style={{ cursor: "default" }}>
                  <IconCircleCheckFilled size="1.1rem" />
                </Text>
              </Tooltip>
            )}
          </Group>
          <Group gap={4}>
            <Tooltip label={t("Home.Accounts.UpdateStats")}>
              <ActionIcon variant="subtle" color="gray" onClick={() => reload()}>
                <IconRefresh size="1rem" />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("Home.Accounts.DownloadGames")}>
              <ActionIcon
                variant="subtle"
                color="gray"
                loading={loading}
                disabled={loading}
                onClick={async () => {
                  setLoading(true);
                  await syncAccountGames({
                    type,
                    username: title,
                    token,
                    total,
                    database,
                    databaseDir,
                    setProgress,
                  });
                  setLoading(false);
                }}
              >
                <IconDownload size="1rem" />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("Home.Accounts.RemoveAccount")}>
              <ActionIcon variant="subtle" color="red" onClick={() => logout()}>
                <IconTrash size="1rem" />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </Card.Section>

      <Card.Section inheritPadding py="md">
        <SimpleGrid cols={1} spacing="xs">
          {items}
        </SimpleGrid>
      </Card.Section>

      <Card.Section inheritPadding pb="sm">
        <Stack gap={4}>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {t("Common.Games")}
            </Text>
            <Text size="xs" fw={500}>
              {downloadedGames} / {effectiveTotal}
            </Text>
          </Group>
          <Progress
            value={loading ? 100 : (downloadedGames / effectiveTotal) * 100}
            size="sm"
            striped={loading}
            animated={loading}
          />
          <Group justify="space-between" mt={4}>
            <Text size="xs" c="dimmed">
              {t("Home.Accounts.LastUpdate", {
                date: new Date(updatedAt).toLocaleDateString(),
                interpolation: { escapeValue: false },
              })}
            </Text>
            {loading && progress && (
              <Text size="xs" c="dimmed">
                {progress.toFixed(0)}%
              </Text>
            )}
          </Group>
        </Stack>
      </Card.Section>
    </Card>
  );
}
