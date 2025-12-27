import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  discoverInstalledPlugins,
  loadPluginCommands,
  loadPluginSkillsAsCommands,
  loadPluginAgents,
  loadPluginMcpServers,
  loadPluginHooksConfigs,
  loadAllPluginComponents,
} from "./loader"
import type { LoadedPlugin, InstalledPluginsDatabase, ClaudeSettings, PluginScope } from "./types"
import type { McpLocalConfig } from "../claude-code-mcp-loader/types"

// #region Test Helpers

function createTempDir(): string {
  const tempDir = join(tmpdir(), `claude-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tempDir, { recursive: true })
  return tempDir
}

function setupTestEnvironment(tempDir: string) {
  const pluginsDir = join(tempDir, "plugins")
  const settingsDir = tempDir
  mkdirSync(pluginsDir, { recursive: true })

  process.env.CLAUDE_PLUGINS_HOME = pluginsDir
  process.env.CLAUDE_SETTINGS_PATH = join(settingsDir, "settings.json")

  return { pluginsDir, settingsDir }
}

function cleanupTestEnvironment(tempDir: string) {
  delete process.env.CLAUDE_PLUGINS_HOME
  delete process.env.CLAUDE_SETTINGS_PATH
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function createInstalledPluginsDb(
  pluginsDir: string,
  plugins: Record<string, { installPath: string; scope?: string; version?: string }[]>
): void {
  const db: InstalledPluginsDatabase = {
    version: 1,
    plugins: {},
  }

  for (const [key, installations] of Object.entries(plugins)) {
    db.plugins[key] = installations.map((inst) => ({
      scope: (inst.scope || "user") as PluginScope,
      installPath: inst.installPath,
      version: inst.version || "1.0.0",
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    }))
  }

  writeFileSync(join(pluginsDir, "installed_plugins.json"), JSON.stringify(db, null, 2))
}

function createSettings(settingsDir: string, settings: ClaudeSettings): void {
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(settings, null, 2))
}

function createPluginStructure(
  pluginPath: string,
  options: {
    manifest?: { name: string; version?: string; description?: string }
    commands?: Array<{ name: string; content: string }>
    skills?: Array<{ name: string; content: string }>
    agents?: Array<{ name: string; content: string }>
    hooks?: object
    mcp?: object
  }
): void {
  mkdirSync(pluginPath, { recursive: true })

  // #given manifest exists
  if (options.manifest) {
    const manifestDir = join(pluginPath, ".claude-plugin")
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(join(manifestDir, "plugin.json"), JSON.stringify(options.manifest, null, 2))
  }

  // #given commands exist
  if (options.commands) {
    const commandsDir = join(pluginPath, "commands")
    mkdirSync(commandsDir, { recursive: true })
    for (const cmd of options.commands) {
      writeFileSync(join(commandsDir, `${cmd.name}.md`), cmd.content)
    }
  }

  // #given skills exist
  if (options.skills) {
    const skillsDir = join(pluginPath, "skills")
    mkdirSync(skillsDir, { recursive: true })
    for (const skill of options.skills) {
      const skillDir = join(skillsDir, skill.name)
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, "SKILL.md"), skill.content)
    }
  }

  // #given agents exist
  if (options.agents) {
    const agentsDir = join(pluginPath, "agents")
    mkdirSync(agentsDir, { recursive: true })
    for (const agent of options.agents) {
      writeFileSync(join(agentsDir, `${agent.name}.md`), agent.content)
    }
  }

  // #given hooks exist
  if (options.hooks) {
    const hooksDir = join(pluginPath, "hooks")
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(join(hooksDir, "hooks.json"), JSON.stringify(options.hooks, null, 2))
  }

  // #given mcp exists
  if (options.mcp) {
    writeFileSync(join(pluginPath, ".mcp.json"), JSON.stringify(options.mcp, null, 2))
  }
}

// #endregion

describe("claude-code-plugin-loader", () => {
  let tempDir: string
  let pluginsDir: string
  let settingsDir: string

  beforeEach(() => {
    tempDir = createTempDir()
    const env = setupTestEnvironment(tempDir)
    pluginsDir = env.pluginsDir
    settingsDir = env.settingsDir
  })

  afterEach(() => {
    cleanupTestEnvironment(tempDir)
  })

  describe("discoverInstalledPlugins", () => {
    it("should return empty result when no plugins database exists", () => {
      // #given no installed_plugins.json
      // #when discovering plugins
      const result = discoverInstalledPlugins()

      // #then should return empty
      expect(result.plugins).toEqual([])
      expect(result.errors).toEqual([])
    })

    it("should discover plugins from installed_plugins.json", () => {
      // #given a plugin is installed
      const pluginPath = join(tempDir, "test-plugin")
      createPluginStructure(pluginPath, {
        manifest: { name: "test-plugin", version: "1.0.0" },
      })

      createInstalledPluginsDb(pluginsDir, {
        "test-plugin@marketplace": [{ installPath: pluginPath }],
      })

      // #when discovering plugins
      const result = discoverInstalledPlugins()

      // #then should find the plugin
      expect(result.plugins.length).toBe(1)
      expect(result.plugins[0].name).toBe("test-plugin")
      expect(result.plugins[0].version).toBe("1.0.0")
      expect(result.errors).toEqual([])
    })

    it("should derive plugin name from key when no manifest exists", () => {
      // #given a plugin without manifest (simple plugin format)
      const pluginPath = join(tempDir, "simple-plugin")
      mkdirSync(pluginPath, { recursive: true })

      createInstalledPluginsDb(pluginsDir, {
        "simple-plugin@marketplace": [{ installPath: pluginPath }],
      })

      // #when discovering plugins
      const result = discoverInstalledPlugins()

      // #then should derive name from plugin key
      expect(result.plugins.length).toBe(1)
      expect(result.plugins[0].name).toBe("simple-plugin")
    })

    it("should report error when plugin path does not exist", () => {
      // #given a plugin with non-existent path
      createInstalledPluginsDb(pluginsDir, {
        "missing-plugin@marketplace": [{ installPath: "/non/existent/path" }],
      })

      // #when discovering plugins
      const result = discoverInstalledPlugins()

      // #then should report error
      expect(result.plugins).toEqual([])
      expect(result.errors.length).toBe(1)
      expect(result.errors[0].pluginKey).toBe("missing-plugin@marketplace")
      expect(result.errors[0].error).toContain("does not exist")
    })

    it("should respect enabledPlugins from settings.json", () => {
      // #given two plugins with one disabled in settings
      const plugin1Path = join(tempDir, "plugin1")
      const plugin2Path = join(tempDir, "plugin2")
      mkdirSync(plugin1Path, { recursive: true })
      mkdirSync(plugin2Path, { recursive: true })

      createInstalledPluginsDb(pluginsDir, {
        "plugin1@marketplace": [{ installPath: plugin1Path }],
        "plugin2@marketplace": [{ installPath: plugin2Path }],
      })

      createSettings(settingsDir, {
        enabledPlugins: {
          "plugin1@marketplace": false,
          "plugin2@marketplace": true,
        },
      })

      // #when discovering plugins
      const result = discoverInstalledPlugins()

      // #then should only load enabled plugin
      expect(result.plugins.length).toBe(1)
      expect(result.plugins[0].name).toBe("plugin2")
    })

    it("should respect enabledPluginsOverride option over settings", () => {
      // #given a plugin disabled in settings but enabled in override
      const pluginPath = join(tempDir, "override-test")
      mkdirSync(pluginPath, { recursive: true })

      createInstalledPluginsDb(pluginsDir, {
        "override-test@marketplace": [{ installPath: pluginPath }],
      })

      createSettings(settingsDir, {
        enabledPlugins: {
          "override-test@marketplace": false,
        },
      })

      // #when discovering with override
      const result = discoverInstalledPlugins({
        enabledPluginsOverride: {
          "override-test@marketplace": true,
        },
      })

      // #then should load the plugin (override wins)
      expect(result.plugins.length).toBe(1)
      expect(result.plugins[0].name).toBe("override-test")
    })

    it("should detect component directories", () => {
      // #given a plugin with all components
      const pluginPath = join(tempDir, "full-plugin")
      createPluginStructure(pluginPath, {
        manifest: { name: "full-plugin", version: "2.0.0" },
        commands: [{ name: "test-cmd", content: "# Test" }],
        skills: [{ name: "test-skill", content: "# Skill" }],
        agents: [{ name: "test-agent", content: "# Agent" }],
        hooks: { hooks: {} },
        mcp: { mcpServers: {} },
      })

      createInstalledPluginsDb(pluginsDir, {
        "full-plugin@marketplace": [{ installPath: pluginPath }],
      })

      // #when discovering plugins
      const result = discoverInstalledPlugins()

      // #then should detect all component paths
      expect(result.plugins.length).toBe(1)
      const plugin = result.plugins[0]
      expect(plugin.commandsDir).toBe(join(pluginPath, "commands"))
      expect(plugin.skillsDir).toBe(join(pluginPath, "skills"))
      expect(plugin.agentsDir).toBe(join(pluginPath, "agents"))
      expect(plugin.hooksPath).toBe(join(pluginPath, "hooks", "hooks.json"))
      expect(plugin.mcpPath).toBe(join(pluginPath, ".mcp.json"))
    })
  })

  describe("loadPluginCommands", () => {
    it("should load commands from plugins", () => {
      // #given a plugin with commands
      const pluginPath = join(tempDir, "cmd-plugin")
      const commandsDir = join(pluginPath, "commands")
      mkdirSync(commandsDir, { recursive: true })
      writeFileSync(
        join(commandsDir, "greet.md"),
        `---
description: Greet the user
argument-hint: <name>
---
Say hello to the user named $ARGUMENTS`
      )

      const plugins: LoadedPlugin[] = [
        {
          name: "cmd-plugin",
          version: "1.0.0",
          scope: "user",
          installPath: pluginPath,
          pluginKey: "cmd-plugin@test",
          commandsDir,
        },
      ]

      // #when loading commands
      const commands = loadPluginCommands(plugins)

      // #then should load namespaced command
      expect(Object.keys(commands)).toContain("cmd-plugin:greet")
      const cmd = commands["cmd-plugin:greet"]
      expect(cmd.description).toContain("(plugin: cmd-plugin)")
      expect(cmd.description).toContain("Greet the user")
      expect(cmd.argumentHint).toBe("<name>")
      expect(cmd.template).toContain("$ARGUMENTS")
    })

    it("should return empty object when no commands directory", () => {
      // #given a plugin without commands
      const plugins: LoadedPlugin[] = [
        {
          name: "no-cmd-plugin",
          version: "1.0.0",
          scope: "user",
          installPath: tempDir,
          pluginKey: "no-cmd-plugin@test",
        },
      ]

      // #when loading commands
      const commands = loadPluginCommands(plugins)

      // #then should return empty
      expect(Object.keys(commands)).toEqual([])
    })
  })

  describe("loadPluginAgents", () => {
    it("should load agents from plugins", () => {
      // #given a plugin with agents
      const pluginPath = join(tempDir, "agent-plugin")
      const agentsDir = join(pluginPath, "agents")
      mkdirSync(agentsDir, { recursive: true })
      writeFileSync(
        join(agentsDir, "helper.md"),
        `---
description: A helpful assistant
tools: read,write,bash
---
You are a helpful assistant that can read and write files.`
      )

      const plugins: LoadedPlugin[] = [
        {
          name: "agent-plugin",
          version: "1.0.0",
          scope: "user",
          installPath: pluginPath,
          pluginKey: "agent-plugin@test",
          agentsDir,
        },
      ]

      // #when loading agents
      const agents = loadPluginAgents(plugins)

      // #then should load namespaced agent
      expect(Object.keys(agents)).toContain("agent-plugin:helper")
      const agent = agents["agent-plugin:helper"]
      expect(agent.description).toContain("(plugin: agent-plugin)")
      expect(agent.description).toContain("A helpful assistant")
      expect(agent.mode).toBe("subagent")
      expect(agent.prompt).toContain("You are a helpful assistant")
      expect(agent.tools).toEqual({ read: true, write: true, bash: true })
    })
  })

  describe("loadPluginSkillsAsCommands", () => {
    it("should load skills as commands from plugins", () => {
      // #given a plugin with skills
      const pluginPath = join(tempDir, "skill-plugin")
      const skillsDir = join(pluginPath, "skills")
      const skillDir = join(skillsDir, "code-review")
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---
name: code-review
description: Review code for issues
---
Review the provided code for bugs, security issues, and best practices.`
      )

      const plugins: LoadedPlugin[] = [
        {
          name: "skill-plugin",
          version: "1.0.0",
          scope: "user",
          installPath: pluginPath,
          pluginKey: "skill-plugin@test",
          skillsDir,
        },
      ]

      // #when loading skills
      const skills = loadPluginSkillsAsCommands(plugins)

      // #then should load namespaced skill
      expect(Object.keys(skills)).toContain("skill-plugin:code-review")
      const skill = skills["skill-plugin:code-review"]
      expect(skill.description).toContain("(plugin: skill-plugin - Skill)")
      expect(skill.description).toContain("Review code for issues")
      expect(skill.template).toContain("Review the provided code")
    })
  })

  describe("loadPluginMcpServers", () => {
    it("should load MCP servers from plugins", async () => {
      // #given a plugin with MCP config
      const pluginPath = join(tempDir, "mcp-plugin")
      mkdirSync(pluginPath, { recursive: true })
      writeFileSync(
        join(pluginPath, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "test-server": {
              command: "node",
              args: ["${CLAUDE_PLUGIN_ROOT}/server.js"],
            },
          },
        })
      )

      const plugins: LoadedPlugin[] = [
        {
          name: "mcp-plugin",
          version: "1.0.0",
          scope: "user",
          installPath: pluginPath,
          pluginKey: "mcp-plugin@test",
          mcpPath: join(pluginPath, ".mcp.json"),
        },
      ]

      // #when loading MCP servers
      const servers = await loadPluginMcpServers(plugins)

      // #then should load namespaced server with resolved paths
      expect(Object.keys(servers)).toContain("mcp-plugin:test-server")
      const server = servers["mcp-plugin:test-server"] as McpLocalConfig
      expect(server.type).toBe("local")
      expect(server.command).toContain("node")
    })

    it("should skip disabled MCP servers", async () => {
      // #given a plugin with disabled MCP server
      const pluginPath = join(tempDir, "mcp-disabled-plugin")
      mkdirSync(pluginPath, { recursive: true })
      writeFileSync(
        join(pluginPath, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "disabled-server": {
              command: "node",
              args: ["server.js"],
              disabled: true,
            },
          },
        })
      )

      const plugins: LoadedPlugin[] = [
        {
          name: "mcp-disabled-plugin",
          version: "1.0.0",
          scope: "user",
          installPath: pluginPath,
          pluginKey: "mcp-disabled-plugin@test",
          mcpPath: join(pluginPath, ".mcp.json"),
        },
      ]

      // #when loading MCP servers
      const servers = await loadPluginMcpServers(plugins)

      // #then should not load disabled server
      expect(Object.keys(servers)).toEqual([])
    })
  })

  describe("loadPluginHooksConfigs", () => {
    it("should load hooks configs from plugins", () => {
      // #given a plugin with hooks
      const pluginPath = join(tempDir, "hooks-plugin")
      const hooksDir = join(pluginPath, "hooks")
      mkdirSync(hooksDir, { recursive: true })
      writeFileSync(
        join(hooksDir, "hooks.json"),
        JSON.stringify({
          hooks: {
            PostToolUse: [
              {
                matcher: "Write|Edit",
                hooks: [{ type: "command", command: "eslint --fix $FILE" }],
              },
            ],
          },
        })
      )

      const plugins: LoadedPlugin[] = [
        {
          name: "hooks-plugin",
          version: "1.0.0",
          scope: "user",
          installPath: pluginPath,
          pluginKey: "hooks-plugin@test",
          hooksPath: join(hooksDir, "hooks.json"),
        },
      ]

      // #when loading hooks configs
      const configs = loadPluginHooksConfigs(plugins)

      // #then should load hooks config
      expect(configs.length).toBe(1)
      expect(configs[0].hooks?.PostToolUse).toBeDefined()
      expect(configs[0].hooks?.PostToolUse?.[0].matcher).toBe("Write|Edit")
    })
  })

  describe("loadAllPluginComponents", () => {
    it("should load all components from all plugins", async () => {
      // #given a plugin with all components
      const pluginPath = join(tempDir, "all-in-one-plugin")
      createPluginStructure(pluginPath, {
        manifest: { name: "all-in-one", version: "1.0.0" },
        commands: [
          {
            name: "test-cmd",
            content: `---
description: Test command
---
Test command content`,
          },
        ],
        agents: [
          {
            name: "test-agent",
            content: `---
description: Test agent
---
Test agent prompt`,
          },
        ],
        skills: [
          {
            name: "test-skill",
            content: `---
name: test-skill
description: Test skill
---
Test skill content`,
          },
        ],
        hooks: {
          hooks: {
            Stop: [{ hooks: [{ type: "prompt", prompt: "Done!" }] }],
          },
        },
        mcp: {
          mcpServers: {
            "local-server": {
              command: "node",
              args: ["server.js"],
            },
          },
        },
      })

      createInstalledPluginsDb(pluginsDir, {
        "all-in-one@marketplace": [{ installPath: pluginPath }],
      })

      // #when loading all components
      const result = await loadAllPluginComponents()

      // #then should have all components loaded
      expect(result.plugins.length).toBe(1)
      expect(Object.keys(result.commands)).toContain("all-in-one:test-cmd")
      expect(Object.keys(result.agents)).toContain("all-in-one:test-agent")
      expect(Object.keys(result.skills)).toContain("all-in-one:test-skill")
      expect(Object.keys(result.mcpServers)).toContain("all-in-one:local-server")
      expect(result.hooksConfigs.length).toBe(1)
      expect(result.errors).toEqual([])
    })
  })
})
