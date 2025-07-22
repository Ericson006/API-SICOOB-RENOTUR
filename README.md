
# API-SICOOB-RENOTUR

Este projeto foi desenvolvido para automatizar o processo de geração e verificação de cobranças via PIX, utilizando a API do SICOOB. É uma solução interna da empresa **Renotur Transporte Turístico LTDA.** que otimiza o processo de vendas, integração com WhatsApp e confirmações automáticas de pagamento.

## Funcionalidades

- Geração automática de QR Code PIX
- Atualização em tempo real do status de pagamento
- Interface amigável via navegador
- Integração com base de dados (Supabase)
- Segurança com uso de certificado digital
- Sistema interno 100% automatizado

## Tecnologias utilizadas

- Python 3.11+
- Flask
- HTML/CSS/JS (Frontend)
- Supabase (banco de dados)
- API Sicoob Pix (com certificado digital A1)

## Como executar localmente

1. Clone este repositório.
2. Instale os requisitos:

    pip install -r requirements.txt

3. Configure as variáveis de ambiente e os certificados conforme necessário.
4. Execute o servidor:

    python server.py

5. Acesse via navegador: `(https://api-sicoob-renotur.onrender.com)`

## Estrutura de pastas


.
├── server.py
├── gera_pix.py
├── static/
├── templates/
│   ├── gerador_pix.html
│   └── pix_template.html
├── cobrancas/
└── README.md


## Suporte

Para dúvidas, sugestões ou manutenção do sistema, entre em contato com o setor responsável da Renotur.

---

## Licença

**Copyright © 2025**  
**Renotur Transporte Turístico LTDA.**  
**CNPJ: 04.763.318/0001-85**  

Este software foi desenvolvido exclusivamente para uso interno da empresa Renotur Transporte Turístico LTDA.  
A lógica de automação, estrutura do código-fonte, organização funcional e interface do sistema são consideradas propriedade intelectual da titular, protegidas pela Lei de Direitos Autorais (Lei nº 9.610/98) e demais legislações aplicáveis.

É vedada a reprodução, distribuição, comercialização ou adaptação parcial ou total deste software sem a autorização expressa e formal da empresa detentora dos direitos.

O acesso ao código-fonte não implica em cessão de direitos, licença de uso externa, nem autorização para redistribuição.

Todas as permissões de uso, caso existam, devem estar devidamente registradas em contrato específico, firmado entre as partes.

Para informações adicionais, dúvidas ou solicitação de uso, entre em contato com o setor responsável dentro da organização.

---

Este documento é parte integrante da documentação do sistema **"API-SICOOB-RENOTUR"**.
