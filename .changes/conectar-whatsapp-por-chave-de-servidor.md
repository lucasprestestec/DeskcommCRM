---
impacto: capacidade_nova
secao: adicionado
titulo: Sistemas ligados por chave de gerente podem conectar o WhatsApp do cliente pelo Cadastro Incorporado
---

As duas rotas do botão "Conectar WhatsApp" (`/api/v1/channels/official/cadastro-incorporado`)
passam a aceitar, além da sessão de administrador, uma chave de servidor `dsk_…` de gerente com
escopo de escrita. A organização vem sempre da chave, nunca do corpo, e o App Secret da Meta
continua só no CRM. Serve a sistemas como o Chico, que mostram o botão na própria tela do
cliente. Sem chave de servidor nada muda.
