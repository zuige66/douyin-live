"""把 mcp.json 里的 server 预置成「已信任」，省掉在界面点 Trust 的一步。

算法来自 5.9.2 / 5.8.4 的 app.asar（已用三条已有记录验证过，逐字节吻合）：

    trustMaterial(stdio) = [command, sorted(args).join(','), sorted(envKeys).join(','), cwd?].join('|')
    approvalKey          = sha256(trustMaterial) + '::' + name
    mcp-approvals.json   = { approvalKey: epoch_ms }
"""

import hashlib
import json
import os
import sys
import time


def trust_material_stdio(command, args, env_keys, cwd=None):
    parts = [command, ",".join(sorted(str(a) for a in args)), ",".join(sorted(env_keys))]
    if cwd:
        parts.append(cwd)
    return "|".join(parts)


def sha256(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def approve(config_dir, names=None):
    cfg_path = os.path.join(config_dir, "mcp.json")
    appr_path = os.path.join(config_dir, "mcp-approvals.json")

    if not os.path.exists(cfg_path):
        print("[skip] %s 没有 mcp.json" % config_dir)
        return

    with open(cfg_path, "r", encoding="utf-8") as f:
        servers = (json.load(f) or {}).get("mcpServers") or {}

    if os.path.exists(appr_path):
        try:
            with open(appr_path, "r", encoding="utf-8") as f:
                approvals = json.load(f) or {}
        except Exception:
            approvals = {}
    else:
        approvals = {}

    now = int(time.time() * 1000)
    changed = []
    stale = []

    for name, entry in servers.items():
        if names and name not in names:
            continue
        if not isinstance(entry, dict):
            continue
        command = entry.get("command")
        if not isinstance(command, str) or not command:
            continue  # 只处理 stdio，http/sse 用 origin 做材料，这里用不到
        args = entry.get("args") or []
        env = entry.get("env") or {}
        cwd = entry.get("cwd")
        material = trust_material_stdio(command, args, list(env.keys()), cwd)
        key = sha256(material) + "::" + name

        # 同一 name 的旧记录（配置改过 hash 就变了）要清掉，否则文件越攒越乱
        for old in [k for k in approvals if k.endswith("::" + name) and k != key]:
            del approvals[old]
            stale.append(old.split("::")[0][:8])

        if key not in approvals:
            approvals[key] = now
            changed.append(name)

    with open(appr_path, "w", encoding="utf-8") as f:
        json.dump(approvals, f, ensure_ascii=False, indent=2)

    print("[ok] %s -> %d 条信任记录（新增 %s，清理旧 %s）"
          % (appr_path, len(approvals), changed or "无", stale or "无"))


if __name__ == "__main__":
    for d in sys.argv[1:]:
        approve(d)
