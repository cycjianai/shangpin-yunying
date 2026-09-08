# 仓库与 GitHub 同步规范

## 单主分支

- GitHub 远端只保留 `main`，并将其设为默认分支。
- 平台、任务类型、实验或版本差异通过目录、文件、配置和版本号管理，不用长期分支管理。
- 日常更新直接基于最新 `origin/main`。如工具临时创建本地工作分支，交付前必须将其 fast-forward 或合并到
  `main`，完成验证后删除本地和远端临时分支。
- 禁止把“已推送临时分支”称为“已同步 GitHub”。只有 `origin/main` 包含目标提交且远端仅剩 `main` 才算同步完成。

同步前后固定执行：

```bash
git fetch origin --prune
git status --short
git merge-base --is-ancestor origin/main HEAD
git push origin main
git ls-remote --heads origin
```

完成门：工作区无遗漏；测试与 `quick_validate.py` 通过；本地 `main`、`origin/main` 提交一致；
`git ls-remote --heads origin` 只输出 `refs/heads/main`。删除远端分支前必须先证明其提交已进入 `main`。

## 提交边界

- 每次提交只包含跨账号可复用的代码、合同、测试和低敏规则。
- 禁止提交 tenant、store、SPU、Cookie、签名、密钥、验证码、上传回执、任务目录和用户工作簿。
- 能力变更必须同步升级 `VERSION`、SKILL 标题、回归样例；平台模块状态必须真实，未实现写 `planned`，不得伪装可用。

## 本地安装与远端一致

用户要求同步本地 Skill 时，定位实际被发现/加载的技能目录，不能把 work/ 中的 Git 克隆当成已安装。
本地旧目录若被其他脚本引用，保留该兼容路径并替换整份技能内容；不要额外留下另一个可发现的旧入口。
旧包和运行数据备份放在技能发现目录之外，检查活动任务对冻结文件的依赖后再替换。

验证后推送本次 Skill 仓库的 main，确认远端提交，再按该提交的完整跟踪文件清单同步安装目录。
排除 .git、依赖目录、缓存和运行数据；逐文件校验相对路径、可执行位及 SHA-256，检查安装目录不存在遗留旧源码。
VERSION、SKILL 标题、package/lock 与 UI metadata 的技能名须一致。交付同时报告远端提交和实际安装路径的校验结果。
