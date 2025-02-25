import { 
  ArrayNode,
  AST,
  ASTNode,
  AttributeNode,
  BlockNode,
  DictionaryNode,
  EOFNode,
  LiteralNode,
  LiteralType, 
  NodeType,
  RecoveryNode
} from "./ast";
import type { Lexer } from "./lexer";
import { Token, TokenType } from "./token";

export class Parser {
  private tokens: Token[];
  private ast: AST;
  private currentToken: Token;
  private pc: number; // program counter

  constructor(lexer: Lexer) {
    this.ast = [];
    let token = lexer.nextToken();
    this.tokens = [];
    this.tokens.push(token);
    while (token.tokenType !== TokenType.EOF) {
      token = lexer.nextToken();
      this.tokens.push(token);
    }
    this.pc = 0;
    this.currentToken = this.tokens[this.pc];
    this.createAST();
  }

  private nextToken(): void {
    this.pc += 1;
    if (this.pc >= this.tokens.length) {
      this.currentToken = this.tokens[this.tokens.length - 1];
    } else {
      this.currentToken = this.tokens[this.pc];
    }
  }

  private peekToken(i = 1): Token {
    if (this.pc + i >= this.tokens.length - 1) {
      return this.tokens[this.tokens.length - 1];
    }
    if (this.pc + i < 0) {
      return this.tokens[0];
    }
    return this.tokens[this.pc + i];
  }

  private nextNode(): ASTNode {
    while (this.currentToken.tokenType === TokenType.NEW_LINE) {
      this.nextToken();
    }
    switch(this.currentToken.tokenType) {
      case TokenType.SYMBOL: {
        return this.handleSymbol();
      }
      case TokenType.EOF: {
        return {
          type: NodeType.EOF_NODE,
          value: this.currentToken
        } as EOFNode;
      }
      default: {
        const token = this.currentToken;
        this.nextToken();
        return this.handleRecoveryNode(
          'Unexpected Token. Expected Assignment Name or Block Name.',
          token
        );
      }
    }
  }

  private handleSymbol(): AttributeNode | BlockNode | RecoveryNode {
    switch(this.peekToken().tokenType) {
      case TokenType.ASSIGNMENT_OP: {
        return this.handleAttribute();
      }
      case TokenType.STRING: {
        return this.handleBlockNode();
      }
      case TokenType.OPEN_BRACKET: {
        return this.handleBlockNode();
      }
      default: {
        this.nextToken();
        return this.handleRecoveryNode(
          'Unexpected token. Expected Attribute or Block definition.',
          this.currentToken,
        );
      }
    }
  }

  private handleAttribute(): AttributeNode {
    const name = this.currentToken;
    this.nextToken();
    const assignmentOp = this.currentToken;
    this.nextToken();
    let value: ASTNode;
    switch (this.currentToken.tokenType) {
      case TokenType.STRING: {
        value = this.handleLiteralNode(LiteralType.STRING);
        break;
      }
      case TokenType.INTEGER: {
        value = this.handleLiteralNode(LiteralType.INTEGER);
        break;
      }
      case TokenType.DECIMAL: {
        value = this.handleLiteralNode(LiteralType.DECIMAL)
        break;
      }
      case TokenType.OPEN_BRACKET: {
        value = this.handleDictionaryNode();
        break;
      }
      case TokenType.OPEN_ARRAY: {
        value = this.handleArrayNode();
        break;
      }
      case TokenType.HEREDOC: {
        value = this.handleLiteralNode(LiteralType.HEREDOC);
        break;
      }
      case TokenType.INDENTED_HEREDOC: {
        value = this.handleLiteralNode(LiteralType.INDENTED_HEREDOC);
        break;
      }
      default: {
        if (this.currentToken.value === 'true') {
          value = this.handleLiteralNode(LiteralType.TRUE);
        }
        else if (this.currentToken.value === 'false') {
          value = this.handleLiteralNode(LiteralType.FALSE);
        }
        else {
          value = this.handleRecoveryNode(
            'Unexpected token. Expected literal, dictionary or array after assignment operator.',
            this.currentToken
          );
        }
        break;
      }
    }
    const attributetNode: AttributeNode = {
      assignmentOp,
      name,
      type: NodeType.ATTRIBUTE_NODE,
      value: value,
      children: [value],
    };
    value.parent = attributetNode;
    this.nextToken();
    return attributetNode;
  }

  private handleLiteralNode(literalType: LiteralType, newLineRequired = true): LiteralNode {
    const problems: string[] = [];
    if (newLineRequired === true) {
      if (![TokenType.NEW_LINE, TokenType.EOF].includes(this.peekToken().tokenType)) {
        problems.push('Unexpected token. Expected next token to be newline.')
      }
    }
    if (this.currentToken.tokenError) {
      problems.push(this.currentToken.tokenError);
    }
    return {
      literalType,
      type: NodeType.LITERAL_NODE,
      value: this.currentToken,
      problems: problems,
    }
  }

  private handleDictionaryNode(): DictionaryNode {
    const problems: string[] = [];
    const blockStart = this.currentToken;
    this.nextToken();
    const entries: DictionaryNode["entries"] = [];
    while (![TokenType.CLOSE_BRACKET, TokenType.EOF].includes(this.peekToken().tokenType)) {
      if (this.currentToken.tokenType === TokenType.SYMBOL) {
        entries.push(this.handleAttribute());
      }
      else {
        if (this.currentToken.tokenType !== TokenType.NEW_LINE) {
          problems.push('Unexpected Token. Expected attribute.');
          entries.push(this.handleRecoveryNode(
            'Unexpected Token. Expected attribute.',
            this.currentToken,
          ));
        }
        this.nextToken();
      } 
    }
    this.nextToken();
    let blockEnd = this.currentToken;
    if (this.currentToken.tokenType !== TokenType.CLOSE_BRACKET) {
      problems.push('Unexpected Token. Expected }.')
      blockEnd = {
        value: '}',
        tokenType: TokenType.RECOVERY,
        col: this.currentToken.col,
        ln: this.currentToken.ln
      };
    }
    if (this.peekToken().tokenType !== TokenType.NEW_LINE) {
      problems.push('Unexpected token. Expected new line.');
    }
    const dictionaryNode: DictionaryNode = {
      children: entries,
      blockStart,
      blockEnd,
      entries,
      type: NodeType.DICTIONARY_NODE,
      problems
    };
    for (const attribute of entries) {
      attribute.parent = dictionaryNode;
    }
    return dictionaryNode;
  }

  public handleArrayNode(): ArrayNode {
    const problems: string[] = [];
    const arrayStart = this.currentToken;
    this.nextToken();
    const values: ArrayNode["values"] = [];
    while (![TokenType.CLOSE_ARRAY, TokenType.EOF].includes(this.currentToken.tokenType)) {
      while (this.currentToken.tokenType === TokenType.NEW_LINE) {
        this.nextToken();
      }
      if ([TokenType.CLOSE_ARRAY].includes(this.currentToken.tokenType)) {
        break;
      }
      switch (this.currentToken.tokenType) {
        case TokenType.STRING: {
          values.push(this.handleLiteralNode(LiteralType.STRING, false));
          break;
        }
        case TokenType.INTEGER: {
          values.push(this.handleLiteralNode(LiteralType.INTEGER, false));
          break;
        }
        case TokenType.DECIMAL: {
          values.push(this.handleLiteralNode(LiteralType.DECIMAL, false));
          break;
        }
        case TokenType.OPEN_BRACKET: {
          values.push(this.handleDictionaryNode());
          break;
        }
        default: {
          problems.push('Unexpected Token. Expected literal.');
          values.push(this.handleRecoveryNode(
            'Unexpected Token. Expected literal.',
            this.currentToken,
          ));
          break;
        }
      }
      if (values[values.length-1].type === NodeType.RECOVERY_NODE && this.currentToken.tokenType === TokenType.SYMBOL) {
        if (this.peekToken().tokenType === TokenType.ASSIGNMENT_OP) {
          this.currentToken = this.peekToken(-1);
          this.pc -= 1;
          break;
        }
        else if (this.peekToken().tokenType === TokenType.STRING) {
          let peekCounter = 2;
          while (this.peekToken(peekCounter).tokenType === TokenType.STRING) {
            peekCounter += 1;
          }
          if (this.peekToken(peekCounter).tokenType === TokenType.OPEN_BRACKET) {
            this.currentToken = this.peekToken(-1);
            this.pc -= 1;
            break;
          }
        }
        else if (this.peekToken().tokenType === TokenType.OPEN_BRACKET) {
          this.currentToken = this.peekToken(-1);
          this.pc -= 1;
          break;
        }
      }
      this.nextToken();
      if (this.currentToken.tokenType === TokenType.ARRAY_ITEM_SEPERATOR ) {
        this.nextToken();
      }
      else if (![TokenType.CLOSE_ARRAY].includes(this.currentToken.tokenType) ) {
        while (this.peekToken(0).tokenType === TokenType.NEW_LINE) {
          this.nextToken();
        }
        if (this.peekToken(0).tokenType !== TokenType.CLOSE_ARRAY) {
          problems.push('Missing Token. Expected seperator.');
        }
      }
    }
    let arrayEnd = this.currentToken;
    if (this.currentToken.tokenType !== TokenType.CLOSE_ARRAY) {
      problems.push('Missing Token. Expected ].')
      arrayEnd = {
        value: ']',
        tokenType: TokenType.RECOVERY,
        tokenError: '',
        col: this.currentToken.col,
        ln: this.currentToken.ln
      }
    } else {
      this.nextToken();
    }
    const arrayNode: ArrayNode = {
      children: values,
      type: NodeType.ARRAY_NODE,
      arrayStart,
      arrayEnd,
      values,
      problems,
    }
    for (const val of values) {
      val.parent = arrayNode;
    }
    return arrayNode;
  }

  private handleBlockNode(): BlockNode {
    const problems: string[] = [];
    const name = this.currentToken;
    this.nextToken();
    const labels: BlockNode["labels"] = [];
    while (this.currentToken.tokenType === TokenType.STRING) {
      labels.push(this.handleLiteralNode(LiteralType.STRING, false));
      this.nextToken();
    }
    let blockStart = this.currentToken;
    if (this.currentToken.tokenType !== TokenType.OPEN_BRACKET) {
      problems.push('Missing token. Expected {.');
      const token = this.peekToken(-1);
      blockStart = {
        value: '{',
        tokenType: TokenType.RECOVERY,
        col: token.col,
        ln: token.ln,
      } 
    }
    else {
      this.nextToken();
    }
    if (this.currentToken.tokenType === TokenType.NEW_LINE) {
      this.nextToken();
    }
    else if (this.currentToken.tokenType !== TokenType.CLOSE_BRACKET) {
      problems.push('Missing token. Expected new line.');
    }
    const block: BlockNode["block"] = [];
    while (
      ![TokenType.CLOSE_BRACKET, TokenType.EOF].includes(this.peekToken().tokenType) &&
      ![TokenType.CLOSE_BRACKET, TokenType.EOF].includes(this.currentToken.tokenType)
    ) {
        if (this.currentToken.tokenType !== TokenType.NEW_LINE) {
          block.push(this.nextNode());
        }
        else {
          this.nextToken();
        }
    }
    if (![TokenType.CLOSE_BRACKET, TokenType.EOF].includes(this.currentToken.tokenType)) {
      this.nextToken();
    }
    let blockEnd = this.currentToken;
    if (this.currentToken.tokenType === TokenType.EOF) {
      problems.push('Missing token. Expected }.')
      blockEnd = {
        value: '}',
        tokenType: TokenType.RECOVERY,
        col: this.currentToken.col,
        ln: this.currentToken.ln,
      }
    } else {
      this.nextToken();
    }
    const blockNode: BlockNode = {
      block,
      blockStart,
      blockEnd,
      children: block,
      type: NodeType.BLOCK_NODE,
      name,
      problems,
    }
    if (labels.length > 0) {
      for (const label of labels) {
        label.parent = blockNode;
      }
      blockNode.labels = labels;
    }
    for (const astNode of block) {
      astNode.parent = blockNode;
    }
    return blockNode;
  }

  private handleRecoveryNode(errorMsg: string, unexpectedToken: Token): RecoveryNode {
    return {
      problems: [errorMsg],
      type: NodeType.RECOVERY_NODE,
      unexpectedToken
    };
  }

  private createAST(): void {
    while (this.currentToken.tokenType !== TokenType.EOF) {
      this.ast.push(this.nextNode());
    }
  }

  public getAST() {
    return this.ast;
  }
}
