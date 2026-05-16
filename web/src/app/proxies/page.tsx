"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Gauge,
  Globe2,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Shield,
  Trash2,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  batchCreateManagedProxies,
  createManagedProxy,
  deleteManagedProxy,
  fetchManagedProxies,
  testManagedProxies,
  updateManagedProxy,
  type ManagedProxy,
  type ManagedProxyPayload,
  type ManagedProxyType,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

type ProxyFormState = {
  name: string;
  type: ManagedProxyType;
  host: string;
  port: string;
  username: string;
  password: string;
};

const emptyForm: ProxyFormState = {
  name: "",
  type: "http",
  host: "",
  port: "",
  username: "",
  password: "",
};

function endpoint(proxy: ManagedProxy) {
  return `${proxy.type}://${proxy.host}:${proxy.port}`;
}

function proxyLabel(proxy: ManagedProxy) {
  return proxy.name || endpoint(proxy);
}

function formatDateTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function testStatus(proxy: ManagedProxy) {
  if (proxy.testing || proxy.last_test?.status === "testing") {
    return { label: "测速中", variant: "info" as const, icon: LoaderCircle };
  }
  if (!proxy.last_test) {
    return { label: "未测速", variant: "secondary" as const, icon: Gauge };
  }
  if (proxy.last_test.ok) {
    return { label: "可用", variant: "success" as const, icon: CheckCircle2 };
  }
  return { label: "失败", variant: "danger" as const, icon: WifiOff };
}

function createPayload(form: ProxyFormState): ManagedProxyPayload {
  const payload: ManagedProxyPayload = {
    name: form.name.trim(),
    type: form.type,
    host: form.host.trim(),
    port: Number(form.port),
    username: form.username.trim(),
  };
  if (form.password) {
    payload.password = form.password;
  }
  return payload;
}

function formFromProxy(proxy: ManagedProxy): ProxyFormState {
  return {
    name: proxy.name || "",
    type: proxy.type,
    host: proxy.host || "",
    port: String(proxy.port || ""),
    username: proxy.username || "",
    password: "",
  };
}

function ProxiesPageContent() {
  const didLoadRef = useRef(false);
  const [items, setItems] = useState<ManagedProxy[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<ManagedProxyType | "all">("all");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [editingProxy, setEditingProxy] = useState<ManagedProxy | null>(null);
  const [form, setForm] = useState<ProxyFormState>(emptyForm);
  const [batchText, setBatchText] = useState("");
  const [isBatchSaving, setIsBatchSaving] = useState(false);
  const pendingToastIdsRef = useRef<Set<string>>(new Set());

  const notifyCompletedTests = (nextItems: ManagedProxy[]) => {
    const pendingIds = pendingToastIdsRef.current;
    for (const proxy of nextItems) {
      if (!pendingIds.has(proxy.id) || proxy.testing || proxy.last_test?.status === "testing") {
        continue;
      }
      pendingIds.delete(proxy.id);
      if (proxy.last_test?.ok) {
        const latency = typeof proxy.last_test.latency_ms === "number" ? `${proxy.last_test.latency_ms} ms` : "未知延迟";
        if (proxy.last_test.source === "ip-api" && proxy.last_test.region) {
          toast.success(`${proxyLabel(proxy)} 可用：${latency}，${proxy.last_test.region}`);
        } else {
          toast.success(`${proxyLabel(proxy)} 可用：${latency}`);
        }
      } else {
        toast.error(`${proxyLabel(proxy)} 测速失败`);
      }
    }
  };

  const applyItems = (nextItems: ManagedProxy[]) => {
    notifyCompletedTests(nextItems);
    setItems(nextItems);
    setSelectedIds((prev) => prev.filter((id) => nextItems.some((item) => item.id === id)));
  };

  const loadProxies = async (silent = false) => {
    if (!silent) {
      setIsLoading(true);
    }
    try {
      const data = await fetchManagedProxies();
      applyItems(data.items);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载代理列表失败");
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void loadProxies();
  }, []);

  const hasTesting = items.some((item) => item.testing || item.last_test?.status === "testing");

  useEffect(() => {
    if (!hasTesting) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadProxies(true);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [hasTesting]);

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesQuery =
        !keyword ||
        item.name.toLowerCase().includes(keyword) ||
        item.host.toLowerCase().includes(keyword) ||
        endpoint(item).toLowerCase().includes(keyword) ||
        (item.last_test?.region || "").toLowerCase().includes(keyword) ||
        (item.last_test?.ip || "").toLowerCase().includes(keyword);
      const matchesType = typeFilter === "all" || item.type === typeFilter;
      return matchesQuery && matchesType;
    });
  }, [items, query, typeFilter]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectableIds = useMemo(() => filteredItems.map((item) => item.id), [filteredItems]);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedSet.has(id));
  const selectedTestableIds = selectedIds.filter((id) => {
    const item = items.find((proxy) => proxy.id === id);
    return item && !item.testing && item.last_test?.status !== "testing";
  });

  const summary = useMemo(() => {
    const tested = items.filter((item) => item.last_test && item.last_test.status !== "testing").length;
    const ok = items.filter((item) => item.last_test?.ok).length;
    const failed = items.filter((item) => item.last_test && item.last_test.status !== "testing" && !item.last_test.ok).length;
    const testing = items.filter((item) => item.testing || item.last_test?.status === "testing").length;
    return { total: items.length, tested, ok, failed, testing };
  }, [items]);

  const openCreateDialog = () => {
    setEditingProxy(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEditDialog = (proxy: ManagedProxy) => {
    setEditingProxy(proxy);
    setForm(formFromProxy(proxy));
    setDialogOpen(true);
  };

  const saveProxy = async () => {
    const payload = createPayload(form);
    if (!payload.host || !payload.port || payload.port < 1 || payload.port > 65535) {
      toast.error("请填写有效的地址和端口");
      return;
    }
    setIsSaving(true);
    try {
      const data = editingProxy
        ? await updateManagedProxy(editingProxy.id, payload)
        : await createManagedProxy(payload);
      applyItems(data.items);
      setDialogOpen(false);
      toast.success(editingProxy ? "代理已更新" : "代理已添加");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存代理失败");
    } finally {
      setIsSaving(false);
    }
  };

  const saveBatchProxies = async () => {
    if (!batchText.trim()) {
      toast.error("请输入要批量添加的代理");
      return;
    }
    setIsBatchSaving(true);
    try {
      const data = await batchCreateManagedProxies(batchText);
      applyItems(data.items);
      if (data.errors.length > 0) {
        toast.error(`成功添加 ${data.added} 个，失败 ${data.errors.length} 行`);
      } else {
        toast.success(`成功添加 ${data.added} 个代理`);
        setBatchDialogOpen(false);
        setBatchText("");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "批量添加失败");
    } finally {
      setIsBatchSaving(false);
    }
  };

  const removeProxy = async (proxy: ManagedProxy) => {
    setDeletingId(proxy.id);
    try {
      const data = await deleteManagedProxy(proxy.id);
      applyItems(data.items);
      setSelectedIds((prev) => prev.filter((id) => id !== proxy.id));
      toast.success("代理已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除代理失败");
    } finally {
      setDeletingId("");
    }
  };

  const startTest = async (ids: string[]) => {
    const targets = ids.filter((id) => {
      const item = items.find((proxy) => proxy.id === id);
      return item && !item.testing && item.last_test?.status !== "testing";
    });
    if (targets.length === 0) {
      toast.error("没有可测速的代理");
      return;
    }
    try {
      targets.forEach((id) => pendingToastIdsRef.current.add(id));
      const data = await testManagedProxies(targets);
      applyItems(data.items);
      toast.info(`已开始测速 ${data.started} 个代理`);
    } catch (error) {
      targets.forEach((id) => pendingToastIdsRef.current.delete(id));
      toast.error(error instanceof Error ? error.message : "启动测速失败");
    }
  };

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...selectableIds])));
      return;
    }
    setSelectedIds((prev) => prev.filter((id) => !selectableIds.includes(id)));
  };

  return (
    <>
      <section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">Proxy Manager</div>
          <h1 className="text-2xl font-semibold tracking-tight">代理管理</h1>
          <p className="text-sm text-stone-500">维护代理列表，异步检测连通性、延迟和出口地区。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white/80 px-4 text-stone-700 hover:bg-white"
            onClick={() => void loadProxies()}
            disabled={isLoading}
          >
            <Activity className={cn("size-4", isLoading ? "animate-spin" : "")} />
            刷新
          </Button>
          <Button className="h-10 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800" onClick={openCreateDialog}>
            <Plus className="size-4" />
            添加代理
          </Button>
          <Button variant="outline" className="h-10 rounded-xl border-stone-200 bg-white/80 px-4 text-stone-700 hover:bg-white" onClick={() => setBatchDialogOpen(true)}>
            <Plus className="size-4" />
            批量添加
          </Button>
        </div>
      </section>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent showCloseButton={!isSaving} className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>{editingProxy ? "修改代理" : "添加代理"}</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              支持 http、https、socks5，用户名和密码按需填写。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <label className="text-sm font-medium text-stone-700">名称</label>
              <Input
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="可选，例如 香港 01"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">类型</label>
              <Select value={form.type} onValueChange={(value) => setForm((prev) => ({ ...prev, type: value as ManagedProxyType }))}>
                <SelectTrigger className="h-11 rounded-xl border-stone-200 bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">http</SelectItem>
                  <SelectItem value="https">https</SelectItem>
                  <SelectItem value="socks5">socks5</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">端口</label>
              <Input
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(event) => setForm((prev) => ({ ...prev, port: event.target.value }))}
                placeholder="7890"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <label className="text-sm font-medium text-stone-700">地址</label>
              <Input
                value={form.host}
                onChange={(event) => setForm((prev) => ({ ...prev, host: event.target.value }))}
                placeholder="127.0.0.1 或 proxy.example.com"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">用户名</label>
              <Input
                value={form.username}
                onChange={(event) => setForm((prev) => ({ ...prev, username: event.target.value }))}
                placeholder="可选"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">密码</label>
              <Input
                type="password"
                value={form.password}
                onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
                placeholder={editingProxy?.has_password ? "留空保留原密码" : "可选"}
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setDialogOpen(false)}
              disabled={isSaving}
            >
              取消
            </Button>
            <Button
              className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
              onClick={() => void saveProxy()}
              disabled={isSaving}
            >
              {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={batchDialogOpen} onOpenChange={setBatchDialogOpen}>
        <DialogContent showCloseButton={!isBatchSaving} className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>批量添加代理</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              每行一个，格式：协议|账号:密码@地址:端口；无认证时填写：协议|@地址:端口。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium text-stone-700">代理列表</label>
            <Textarea
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder={"http|user:pass@127.0.0.1:7890\nsocks5|@127.0.0.1:7891"}
              className="min-h-48 rounded-2xl border-stone-200 bg-white font-mono text-sm"
              disabled={isBatchSaving}
            />
          </div>
          <DialogFooter className="pt-2">
            <Button
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setBatchDialogOpen(false)}
              disabled={isBatchSaving}
            >
              取消
            </Button>
            <Button
              className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
              onClick={() => void saveBatchProxies()}
              disabled={isBatchSaving}
            >
              {isBatchSaving ? <LoaderCircle className="size-4 animate-spin" /> : null}
              批量添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <section className="grid gap-3 md:grid-cols-5">
        {[
          { label: "代理总数", value: summary.total, icon: Shield, color: "text-stone-900" },
          { label: "已测速", value: summary.tested, icon: Gauge, color: "text-sky-600" },
          { label: "可用", value: summary.ok, icon: CheckCircle2, color: "text-emerald-600" },
          { label: "失败", value: summary.failed, icon: WifiOff, color: "text-rose-600" },
          { label: "测速中", value: summary.testing, icon: Activity, color: "text-amber-600" },
        ].map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.label} className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
              <CardContent className="p-4">
                <div className="mb-4 flex items-start justify-between">
                  <span className="text-xs font-medium text-stone-400">{card.label}</span>
                  <Icon className="size-4 text-stone-400" />
                </div>
                <div className={cn("text-[1.75rem] font-semibold tracking-tight", card.color)}>{card.value}</div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <Card className="overflow-hidden rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="p-0">
          <div className="flex flex-col gap-3 border-b border-stone-100 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold tracking-tight">代理列表</h2>
              <Badge variant="secondary" className="rounded-lg bg-stone-200 px-2 py-0.5 text-stone-700">
                {filteredItems.length}
              </Badge>
            </div>
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
              <div className="relative min-w-[260px]">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索名称、地址、IP、地区"
                  className="h-10 rounded-xl border-stone-200 bg-white/85 pl-10"
                />
              </div>
              <Select value={typeFilter} onValueChange={(value) => setTypeFilter(value as ManagedProxyType | "all")}>
                <SelectTrigger className="h-10 w-full rounded-xl border-stone-200 bg-white/85 lg:w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部类型</SelectItem>
                  <SelectItem value="http">http</SelectItem>
                  <SelectItem value="https">https</SelectItem>
                  <SelectItem value="socks5">socks5</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-stone-100 px-4 py-3 text-sm text-stone-500">
            <Button
              variant="ghost"
              className="h-8 rounded-lg px-3 text-stone-600 hover:bg-stone-100"
              onClick={() => void startTest(selectedTestableIds)}
              disabled={selectedTestableIds.length === 0}
            >
              <Activity className="size-4" />
              批量测速
            </Button>
            {selectedIds.length > 0 ? (
              <span className="rounded-lg bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">
                已选择 {selectedIds.length} 项
              </span>
            ) : null}
            <span className="text-xs text-stone-400">测速优先使用 ip-api，失败后重新计时改用 httpbin。</span>
          </div>

          {isLoading && items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
              <div className="rounded-xl bg-stone-100 p-3 text-stone-500">
                <LoaderCircle className="size-5 animate-spin" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-stone-700">正在加载代理</p>
                <p className="text-sm text-stone-500">从本地存储读取代理列表。</p>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-left">
                <thead className="border-b border-stone-100 text-[11px] tracking-[0.18em] text-stone-400 uppercase">
                  <tr>
                    <th className="w-12 px-4 py-3">
                      <Checkbox checked={allSelected} onCheckedChange={(checked) => toggleSelectAll(Boolean(checked))} />
                    </th>
                    <th className="w-56 px-4 py-3">代理</th>
                    <th className="w-24 px-4 py-3">类型</th>
                    <th className="w-28 px-4 py-3">状态</th>
                    <th className="w-28 px-4 py-3">延迟</th>
                    <th className="w-64 px-4 py-3">地区 / 出口</th>
                    <th className="w-52 px-4 py-3">上次测速</th>
                    <th className="w-40 px-4 py-3">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((proxy) => {
                    const status = testStatus(proxy);
                    const StatusIcon = status.icon;
                    const isTesting = proxy.testing || proxy.last_test?.status === "testing";
                    return (
                      <tr key={proxy.id} className="border-b border-stone-100/80 text-sm text-stone-600 transition-colors hover:bg-stone-50/70">
                        <td className="px-4 py-3">
                          <Checkbox
                            checked={selectedIds.includes(proxy.id)}
                            onCheckedChange={(checked) => {
                              setSelectedIds((prev) =>
                                checked
                                  ? Array.from(new Set([...prev, proxy.id]))
                                  : prev.filter((id) => id !== proxy.id),
                              );
                            }}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="space-y-1">
                            <div className="font-medium text-stone-800">{proxy.name || endpoint(proxy)}</div>
                            <div className="text-xs text-stone-400">
                              {endpoint(proxy)}
                              {proxy.username ? " · 已配置认证" : ""}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="secondary" className="rounded-md bg-stone-100 text-stone-700">
                            {proxy.type}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={status.variant} className="inline-flex items-center gap-1 rounded-md px-2 py-1">
                            <StatusIcon className={cn("size-3.5", isTesting ? "animate-spin" : "")} />
                            {status.label}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          {proxy.last_test?.ok && typeof proxy.last_test.latency_ms === "number" ? (
                            <span className="font-medium text-stone-800">{proxy.last_test.latency_ms} ms</span>
                          ) : (
                            <span className="text-stone-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {proxy.last_test?.ok ? (
                            <div className="space-y-1">
                              <div className="flex items-center gap-1 text-stone-800">
                                <Globe2 className="size-3.5 text-stone-400" />
                                {proxy.last_test.region || "未返回地区"}
                              </div>
                              <div className="text-xs text-stone-400">
                                {proxy.last_test.ip || "—"}
                                {proxy.last_test.source ? ` · ${proxy.last_test.source}` : ""}
                              </div>
                            </div>
                          ) : proxy.last_test?.error ? (
                            <div className="max-w-[260px] truncate text-xs text-rose-500" title={proxy.last_test.error}>
                              {proxy.last_test.error}
                            </div>
                          ) : (
                            <span className="text-stone-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-stone-500">
                          {formatDateTime(proxy.last_test?.tested_at)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 text-stone-400">
                            <button
                              type="button"
                              className="rounded-lg p-2 transition hover:bg-stone-100 hover:text-stone-700 disabled:opacity-50"
                              onClick={() => openEditDialog(proxy)}
                              disabled={isTesting || deletingId === proxy.id}
                              title="编辑"
                            >
                              <Pencil className="size-4" />
                            </button>
                            <button
                              type="button"
                              className="rounded-lg p-2 transition hover:bg-stone-100 hover:text-stone-700 disabled:opacity-50"
                              onClick={() => void startTest([proxy.id])}
                              disabled={isTesting || deletingId === proxy.id}
                              title="测速"
                            >
                              {isTesting ? <LoaderCircle className="size-4 animate-spin" /> : <Activity className="size-4" />}
                            </button>
                            <button
                              type="button"
                              className="rounded-lg p-2 transition hover:bg-rose-50 hover:text-rose-500 disabled:opacity-50"
                              onClick={() => void removeProxy(proxy)}
                              disabled={isTesting || Boolean(deletingId)}
                              title="删除"
                            >
                              {deletingId === proxy.id ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {!isLoading && filteredItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
                  <div className="rounded-xl bg-stone-100 p-3 text-stone-500">
                    <Search className="size-5" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-stone-700">暂无匹配代理</p>
                    <p className="text-sm text-stone-500">添加代理或调整筛选条件后重试。</p>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default function ProxiesPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <ProxiesPageContent />;
}
