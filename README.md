# Minha Carteira

App para organizar e analisar investimentos (ações, FIIs, ETFs e renda fixa).
Funciona 100% no navegador, sem servidor e sem custo. Os dados de cada pessoa ficam salvos só no navegador dela.

## Arquivos

| Arquivo | Para que serve |
|---|---|
| `index.html` | A página do app |
| `styles.css` | Visual (tema claro/escuro) |
| `app.js` | Toda a lógica: carteira, gráficos, sinais, planejador de aporte |
| `manifest.webmanifest`, `sw.js`, `icon.svg` | Permitem "Instalar app" e uso offline |

## Testar no seu computador

Dê dois cliques em `index.html`. Ele abre no navegador e já funciona.
(O botão "Instalar app" só aparece depois de publicar online, veja abaixo.)

## Publicar de graça (GitHub Pages)

1. Crie uma conta em https://github.com (gratuita).
2. Clique em **New repository**, dê um nome (ex.: `minha-carteira`), marque **Public** e crie.
3. Clique em **uploading an existing file** e arraste todos os arquivos desta pasta. Clique em **Commit changes**.
4. Vá em **Settings → Pages**. Em *Branch*, escolha `main` e `/ (root)` e clique em **Save**.
5. Em 1 ou 2 minutos o link aparece: `https://SEU-USUARIO.github.io/minha-carteira/`

Compartilhe esse link. No Chrome ou Edge, a pessoa clica no ícone de **Instalar** na barra de endereço
e o app ganha um ícone na área de trabalho. No celular, use "Adicionar à tela inicial".

Para atualizar o app, basta subir os arquivos novos no mesmo repositório. Todos recebem a nova versão.

## Cotações automáticas

As cotações vêm da brapi.dev. Cada pessoa cria uma conta gratuita em https://brapi.dev, copia o token
e cola em **Ajustes → Cotações automáticas**. Depois, basta clicar em **Atualizar cotações**.

Se algum indicador não vier pela API (LPA, VPA, dividendos), ele pode ser informado à mão em
**Editar indicadores**. Esses números estão em sites como Status Invest ou Investidor10.

## Aba Mercado

Mostra as ações, FIIs e ETFs mais negociados da B3, com preço, variação do dia, volume, posição no
intervalo de 52 semanas, indicadores (P/L, P/VP, dividend yield) e o sinal de cada um. Dá para ordenar por
mais negociados, maiores altas, maiores baixas ou oportunidades.

Clicando num ativo (ali ou em qualquer ticker da carteira), abre o detalhe com o **gráfico de preço**
(1 mês, 3 meses, 6 meses ou 1 ano) e as linhas do preço-teto e do seu preço médio.
O plano gratuito da brapi costuma liberar até 3 meses de histórico.

As cotações do Mercado são guardadas por 30 minutos para economizar o limite de consultas do token.

## Sugestões no Radar

A aba Radar sugere ativos que **ainda não estão na sua carteira**, pensando no que falta nela:
- tipos de investimento abaixo da meta;
- setores (ações) e segmentos (FIIs) que você ainda não tem, com prioridade para setores perenes;
- exposições que faltam (exterior, small caps, dividendos) no caso dos ETFs;
- preço: ativos com sinal de oportunidade sobem na lista e os com "Esperar" ou "Atenção" saem dela.

São ideias para pesquisar, não recomendações de compra.

## Como os sinais são calculados

- **Ações:** preço-teto = média entre o preço justo de Graham `√(22,5 × LPA × VPA)` e o preço-teto de
  Bazin `dividendos 12m ÷ 6%`.
  - **Oportunidade:** preço pelo menos 15% abaixo do teto e lucro positivo.
  - **Esperar:** mais de 20% acima do teto, ou perto da máxima de 52 semanas e acima do teto.
  - **Atenção:** lucro negativo (uma queda pode ser armadilha de valor).
- **FIIs:**
  - **Oportunidade:** P/VP ≤ 0,95 e dividend yield ≥ 8%.
  - **Esperar:** P/VP ≥ 1,10.
- **ETFs:** posição em relação à máxima e à mínima de 52 semanas.
- **Onde aportar:** divide o valor entre as classes para aproximar a carteira das metas. Dentro de cada
  classe, prioriza ativos com sinal de oportunidade, inclusive os do Radar (ativos que você ainda não tem).

Todos os limites podem ser ajustados em **Ajustes → Critérios dos sinais**.

> Ferramenta educacional. Os sinais não constituem recomendação de investimento.

## Arquivo da carteira (Google Drive / OneDrive)

Em **Ajustes → Arquivo da carteira**, a pessoa guarda a carteira num arquivo na nuvem dela.
Você, como dono do app, não recebe nem armazena dado nenhum.

- **Computador (Chrome ou Edge):** clique em *Salvar carteira num arquivo* e escolha uma pasta do
  Google Drive para computador ou do OneDrive. A partir daí, cada alteração é gravada sozinha no arquivo.
  Em outro computador, use *Abrir arquivo*.
- **Celular, Safari e Firefox:** *Abrir arquivo* busca o arquivo no Drive/OneDrive. Depois de alterar,
  *Salvar no Drive* abre o menu de compartilhar (ou baixa o arquivo) para substituir o antigo.
- **Duas versões diferentes:** se o arquivo foi alterado em outro aparelho e este também tem mudanças,
  o app pergunta qual versão manter, em vez de sobrescrever.

## Backup

Os dados ficam no navegador. Use **Ajustes → Baixar backup** de vez em quando e **Restaurar backup**
para levar a carteira para outro computador ou navegador.
