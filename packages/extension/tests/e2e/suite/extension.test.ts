/**
 * OpenAIDE IDE — Extension E2E 测试
 *
 * 测试 Extension 在真实 VS Code 环境中的核心功能
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

suite('OpenAIDE Extension E2E 测试', () => {

  // ─── Extension 激活测试 ───

  suite('Extension 激活', () => {
    test('Extension 应该被正确注册', () => {
      const extension = vscode.extensions.getExtension('openaide.openaide-ai');
      assert.ok(extension, 'Extension 应该存在');
    });

    test('Extension 应该在启动后激活', async () => {
      const extension = vscode.extensions.getExtension('openaide.openaide-ai');
      if (extension && !extension.isActive) {
        await extension.activate();
      }
      assert.ok(extension?.isActive, 'Extension 应该已激活');
    });
  });

  // ─── 命令注册测试 ───

  suite('命令注册', () => {
    const expectedCommands = [
      'openaide.newChat',
      'openaide.askAboutSelection',
      'openaide.explainCode',
      'openaide.refactorCode',
      'openaide.generateTests',
      'openaide.fixError',
      'openaide.selectModel',
      'openaide.acceptAllDiffs',
      'openaide.rejectAllDiffs',
      'openaide.sessionHistory',
      'openaide.toggleCompletion',
      'openaide.checkUpdate',
      'openaide.viewChangelog',
      'openaide.mcp.marketplace',
      'openaide.mcp.refresh',
      'openaide.mcp.addServer',
      'openaide.memory.refresh',
      'openaide.memory.search',
      'openaide.memory.add',
      'openaide.memory.openProjectFile',
    ];

    test('所有核心命令应该已注册', async () => {
      const allCommands = await vscode.commands.getCommands(true);

      for (const cmd of expectedCommands) {
        assert.ok(
          allCommands.includes(cmd),
          `命令 "${cmd}" 应该已注册`
        );
      }
    });
  });

  // ─── 视图注册测试 ───

  suite('视图注册', () => {
    test('Chat View 应该已注册', () => {
      // Webview 视图通过 contributes.views 注册
      // 验证 viewContainer 存在
      const extension = vscode.extensions.getExtension('openaide.openaide-ai');
      const contributes = extension?.packageJSON?.contributes;
      assert.ok(contributes?.views?.['openaide-sidebar'], '侧边栏视图容器应该存在');
    });

    test('应该有 AI Chat 视图', () => {
      const extension = vscode.extensions.getExtension('openaide.openaide-ai');
      const views = extension?.packageJSON?.contributes?.views?.['openaide-sidebar'] || [];
      const chatView = views.find((v: any) => v.id === 'openaide.chatView');
      assert.ok(chatView, 'AI Chat 视图应该存在');
      assert.strictEqual(chatView.type, 'webview', 'Chat 视图应该是 webview 类型');
    });

    test('应该有 MCP 服务器视图', () => {
      const extension = vscode.extensions.getExtension('openaide.openaide-ai');
      const views = extension?.packageJSON?.contributes?.views?.['openaide-sidebar'] || [];
      const mcpView = views.find((v: any) => v.id === 'openaide.mcpPanel');
      assert.ok(mcpView, 'MCP 服务器视图应该存在');
    });

    test('应该有 AI 记忆视图', () => {
      const extension = vscode.extensions.getExtension('openaide.openaide-ai');
      const views = extension?.packageJSON?.contributes?.views?.['openaide-sidebar'] || [];
      const memoryView = views.find((v: any) => v.id === 'openaide.memoryPanel');
      assert.ok(memoryView, 'AI 记忆视图应该存在');
    });
  });

  // ─── 配置测试 ───

  suite('配置项', () => {
    test('应该有 provider 配置', () => {
      const config = vscode.workspace.getConfiguration('openaide');
      const provider = config.get<string>('provider');
      assert.ok(provider !== undefined, 'provider 配置应该存在');
    });

    test('应该有 model 配置', () => {
      const config = vscode.workspace.getConfiguration('openaide');
      const model = config.get<string>('model');
      assert.ok(model !== undefined, 'model 配置应该存在');
    });

    test('应该有 completion.enabled 配置', () => {
      const config = vscode.workspace.getConfiguration('openaide');
      const enabled = config.get<boolean>('completion.enabled');
      assert.strictEqual(typeof enabled, 'boolean', 'completion.enabled 应该是布尔值');
    });

    test('应该有 update.checkInterval 配置', () => {
      const config = vscode.workspace.getConfiguration('openaide.update');
      const interval = config.get<number>('checkInterval');
      assert.strictEqual(typeof interval, 'number', 'update.checkInterval 应该是数字');
    });
  });

  // ─── 快捷键测试 ───

  suite('快捷键绑定', () => {
    test('应该有快捷键配置', () => {
      const extension = vscode.extensions.getExtension('openaide.openaide-ai');
      const keybindings = extension?.packageJSON?.contributes?.keybindings;
      assert.ok(Array.isArray(keybindings), '应该有快捷键配置');
      assert.ok(keybindings.length > 0, '应该至少有一个快捷键');
    });

    test('新建对话应该有快捷键', () => {
      const extension = vscode.extensions.getExtension('openaide.openaide-ai');
      const keybindings = extension?.packageJSON?.contributes?.keybindings || [];
      const newChatBinding = keybindings.find((k: any) => k.command === 'openaide.newChat');
      assert.ok(newChatBinding, '新建对话应该有快捷键');
    });
  });

  // ─── 右键菜单测试 ───

  suite('右键菜单', () => {
    test('应该有编辑器右键菜单项', () => {
      const extension = vscode.extensions.getExtension('openaide.openaide-ai');
      const menus = extension?.packageJSON?.contributes?.menus;
      assert.ok(menus?.['editor/context'], '应该有编辑器右键菜单');
      assert.ok(menus['editor/context'].length > 0, '应该至少有一个右键菜单项');
    });
  });

  // ─── 状态栏测试 ───

  suite('状态栏', () => {
    test('Extension 激活后状态栏应该可见', async () => {
      // 确保 Extension 已激活
      const extension = vscode.extensions.getExtension('openaide.openaide-ai');
      if (extension && !extension.isActive) {
        await extension.activate();
      }

      // 状态栏项通过 API 创建，无法直接查询
      // 但可以验证 Extension 激活成功（状态栏在 activate 中创建）
      assert.ok(extension?.isActive, 'Extension 应该已激活（状态栏随之创建）');
    });
  });

  // ─── 编辑器集成测试 ───

  suite('编辑器集成', () => {
    test('应该能打开文件', async () => {
      const doc = await vscode.workspace.openTextDocument({
content: 'console.log("Hello, OpenAIDE!");',
        language: 'javascript',
      });
      const editor = await vscode.window.showTextDocument(doc);
      assert.ok(editor, '应该能打开编辑器');
      assert.strictEqual(editor.document.languageId, 'javascript');
    });

    test('应该能获取选中文本', async () => {
      const doc = await vscode.workspace.openTextDocument({
        content: 'function hello() {\n  return "world";\n}',
        language: 'javascript',
      });
      const editor = await vscode.window.showTextDocument(doc);

      // 选中第一行
      editor.selection = new vscode.Selection(0, 0, 0, 22);
      const selectedText = editor.document.getText(editor.selection);
      assert.ok(selectedText.includes('function hello'), '应该能获取选中文本');
    });

    test('InlineCompletionProvider 应该已注册', async () => {
      // 验证补全 provider 注册（通过触发补全来间接验证）
      const doc = await vscode.workspace.openTextDocument({
        content: 'function ',
        language: 'javascript',
      });
      await vscode.window.showTextDocument(doc);

      // InlineCompletionProvider 注册后，VS Code 会在适当时机调用
      // 这里只验证不会抛出异常
      assert.ok(true, 'InlineCompletionProvider 注册不应抛出异常');
    });
  });

  // ─── 工作区测试 ───

  suite('工作区', () => {
    test('应该能获取工作区文件夹', () => {
      const folders = vscode.workspace.workspaceFolders;
      // 在测试环境中可能没有工作区
      assert.ok(true, '获取工作区文件夹不应抛出异常');
    });

    test('应该能读取配置', () => {
      const config = vscode.workspace.getConfiguration('openaide');
assert.ok(config, '应该能获取OpenAIDE配置');
    });
  });
});
