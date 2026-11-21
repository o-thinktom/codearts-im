# 码道内核端点清单（由 OpenAPI 生成）

- openapi: 3.1.1
- title: opencode
- version: 0.0.3
- paths: 37

| 方法 | 路径 | operationId | 摘要 |
|---|---|---|---|
| PUT | `/config/skills/{skill_name}/status` | config.updateSkill | Update skill status |
| GET | `/global/event` | global.event | Get global events |
| GET | `/global/sync-event` | global.sync-event.subscribe | Subscribe to global sync events |
| GET | `/im/welink/list` | digitalAvatar.list | 列出所有数字分身 |
| POST | `/im/welink/start` | digitalAvatar.start | 启动数字分身 |
| GET | `/im/welink/status/{ideType}` | digitalAvatar.status | 获取数字分身状态 |
| POST | `/im/welink/stop` | digitalAvatar.stop | 停止数字分身 |
| POST | `/permission/bash/mode` | permission.bash.mode.set | Set bash execution mode |
| GET | `/permission/bash/mode` | permission.bash.mode.get | Get bash execution mode |
| GET | `/permission/global` | permission.global.get | Get global permissions |
| PUT | `/permission/global` | permission.global.update | Update global permissions |
| GET | `/permission/global/{permission}` | permission.global.getTool | Get tool permissions |
| PATCH | `/permission/global/{permission}` | permission.global.set | Set tool permission |
| DELETE | `/permission/global/{permission}` | permission.global.remove | Remove tool permission |
| GET | `/skillRule` | skillRule.download | Download skill |
| GET | `/v1/skill` | cag.app.skills | List skills |
| GET | `/v1/skills` | skills.list | Get skills |
| POST | `/v1/skills` | skills.create | Create skill |
| PUT | `/v1/skills` | skills.batchModify | Batch modify skills |
| DELETE | `/v1/skills` | skills.delete | Delete skill |
| GET | `/v1/skills/detail` | skills.detail | Get skill detail |
| POST | `/v1/skills/import` | skills.import | Import a skill from zip |
| PATCH | `/v1/skills/sync` | skills.syncByNameList | Sync cloud skills by name list |