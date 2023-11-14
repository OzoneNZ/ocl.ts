import {Lexer} from "./lexer";
import {Parser} from "./parser";
import type {ArrayNode, AST, ASTNode, AttributeNode, BlockNode, DictionaryNode, LiteralNode} from "./ast";
import {LiteralType, NodeType} from "./ast";
import type {Token} from "./token";

/**
 * Return a proxied "root node" that allows the AST to be traversed with simple dot notation. The proxy
 * also returns the correct metadata to allow it to be serialized to JSON.
 * @param input The OCL to parse
 */
export function parseOclWrapper(input: string): any {
    const lexer = new Lexer(input)
    const parser = new Parser(lexer)
    const ast = parser.getAST()

    /*
        The top level object is treated as a "root node" rather than a plain array. It responds to
        any requests to an index or properties like length, but also allows blocks and attributes to
        be returned by name.
     */
    return buildProxy(ast,
        function (target, name): any {
            // return any array based properties as normal
            if (name in target) {
                return wrapItem(target[name as any]);
            }

            const attributes = wrapChildAttributes(target, name.toString())
            if (attributes != undefined) {
                return attributes
            }

            return wrapChildArray(target, name.toString())
        })

}

/**
 * Get a property from a AST node. Properties map to the children of block or dictionary nodes.
 * @param node The node to return the child from
 * @param name The name of the child/property
 */
function getProperty(node: ASTNode | undefined, name: string): any {
    if (!node || !name) {
        return undefined
    }

    // __labels and __name are special property that returns the labels assigned to the block
    // and the name of the block
    if (node.type === NodeType.BLOCK_NODE) {
        if (name === "__labels") {
            return node.labels?.map(l => JSON.parse(l.value.value))
        }

        if (name === "__name") {
            return node.name.value
        }
    }

    // Otherwise we try to find the children with the supplied name
    if (node.type === NodeType.BLOCK_NODE || node.type == NodeType.DICTIONARY_NODE) {
        // find attribute nodes with the name and return the raw value
        const attributes = wrapChildAttributes(node.children, name)
        if (attributes != undefined) {
            return attributes
        }

        return wrapChildArray(node.children, name)
    }

    if (node.type == NodeType.ATTRIBUTE_NODE) {
        return getUnquotedPropertyValue(node)
    }

    return undefined
}

/**
 * Return a plain JavaScript value for attribute nodes. HereDocs are returned in their unprocessed form.
 * @param node The node to return the value of.
 */
function getUnquotedPropertyValue(node: AttributeNode | undefined): string | number | boolean |  DictionaryNode | (string | number | boolean |  DictionaryNode | undefined)[] | undefined {
    if (!node || node.type !== NodeType.ATTRIBUTE_NODE) {
        return undefined
    }

    if (node.value.type === NodeType.ARRAY_NODE) {
        return node.value.children
            .map(c => {
                if (c.type === NodeType.LITERAL_NODE) {
                    return getLiteralValue(c)
                }

                if (c.type === NodeType.DICTIONARY_NODE) {
                    return wrapDictionaryNode(c)
                }

                return undefined
            })
            .filter(c => c !== undefined)
    }

    if (node.value.type === NodeType.LITERAL_NODE) {
        return getLiteralValue(node.value as LiteralNode)
    }

    if (node.value.type === NodeType.DICTIONARY_NODE) {
        return wrapDictionaryNode(node.value)
    }

    return undefined
}

function wrapDictionaryNode(node: DictionaryNode) {
    return buildProxy(node,
        function (target, name) {
            return getProperty(target, name.toString())
        }
    )
}

function getLiteralValue(node: LiteralNode): string | number | boolean {
    const litValueNode = node.value as Token
    const value = litValueNode.value

    if (node.literalType != LiteralType.INDENTED_HEREDOC && node.literalType != LiteralType.HEREDOC) {
        return JSON.parse(value)
    }

    return value
}

/**
 * getOwnPropertyDescriptor is required to allow an object to be serialized to JSON. AST nodes with children expose
 * the child values, otherwise hide all other properties.
 */
function getOwnPropertyDescriptor(target: any, prop: string | symbol) {

    // An attribute assigned to the "root" node
    if ('AttributeNode' === target.type && !target.parent) {
        if (target.name.value === prop.toString()) {
            return {
                configurable: true,
                enumerable: true,
                value: getUnquotedPropertyValue(target)
            }
        }

        return undefined
    }

    if (['AttributeNode', 'BlockNode', 'DictionaryNode'].includes(target.type)) {
        if (prop === "__name") {
            return {
                configurable: true,
                enumerable: true,
                value: target.name
            }
        }

        if (['BlockNode'].includes(target.type)) {
            if (prop === "__labels") {
                return {
                    configurable: true,
                    enumerable: true,
                    value: (target as BlockNode).labels
                }
            }
        }

        const value = getProperty((target as AttributeNode | BlockNode | DictionaryNode), prop.toString())

        if (value !== undefined) {
            return {
                configurable: true,
                enumerable: true,
                value: value
            }
        }
    }

    return Object.getOwnPropertyDescriptor(target, prop)
}

/**
 * ownKeys is required to allow an object to be serialized to JSON. Any AST node with children exposes the
 * children as properties. BlockNodes also expose labels with "__labels". Other properties are hidden.
 */
function ownKeys(target: any) {
    if (['AttributeNode', 'BlockNode', 'DictionaryNode'].includes(target.type)) {

        // A "floating" attribute node
        if ('AttributeNode' === target.type && !target.parent) {
            return [target.name.value]
        }

        const typedTarget = target as AttributeNode | BlockNode | DictionaryNode

        const keys = typedTarget.children
            .filter(c => ['AttributeNode', 'BlockNode'].includes(c.type))
            .map(c => (c as AttributeNode | BlockNode).name.value)
            .filter((value, index, self) => self.indexOf(value) === index)

        keys.push("__name")

        if ('BlockNode' == target.type) {
            keys.push("__labels")
        }

        return keys
    }

    if (['EOFNode', 'LiteralNode', 'RecoveryNode'].includes(target.type)) {
        return []
    }

    if (['ArrayNode'].includes(target.type)) {
        return Reflect.ownKeys((target as ArrayNode).children)
    }

    return Reflect.ownKeys(target)
}

/**
 * Return a single value where appropriate, an array of values where the property lookup had duplicate values, or
 * undefined if there is no attribute node with the supplied name.
 * @param target The target node
 * @param name The name of the property
 */
function wrapChildAttributes(target: AST, name: string) {
    const attributes = target
        ?.filter(c =>
            c.type === NodeType.ATTRIBUTE_NODE &&
            c.name.value === name)
        .map(c => getUnquotedPropertyValue(c as AttributeNode))

    if (attributes !== undefined && attributes.length != 0) {
        if (attributes.length === 1) {
            return attributes.pop()
        }
        return attributes
    }

    return undefined
}

/**
 * Takes a value returned from an array, which could have been an indexed lookup of an object, or could have
 * been a request for the array length, and returns the appropriate value.
 * @param item The property from the array
 */
function wrapItem(item: any): any {
    // assume an object being returned was an index lookup
    if (typeof item === 'object') {
        // this has to be proxied
        return buildProxy(item,
            function (target, name) {
                return getProperty(target, name.toString())
            }
        )
    }

    // anything else is assumed to be a lookup like "length"
    return item
}

/**
 * A no-op set trap because the proxies are read only objects
 */
function set() {
    return true
}

/**
 * Return a collection of block nodes that are themselves proxied to return a single block matching the label
 * or a collection if there are multiple blocks with the same label. Return undefined if no blocks match the name,
 * @param target The target node
 * @param name The name of the child block to return
 */
function wrapChildArray(target: AST, name: string) {
    const children: BlockNode[] = target
        .filter(c => c.type == NodeType.BLOCK_NODE)
        .map(c => c as BlockNode)
        .filter(c => c.name.value === name)

    if (children && children.length != 0) {
        return buildProxy(children,
            function (target: BlockNode[], name) {
                // return any array based properties as normal
                if (name in target) {
                    return wrapItem(target[name as any]);
                }

                // Otherwise, look up the child based on a label
                const children = target.filter(b => b.labels
                    ?.map(l => JSON.parse(l.value.value))
                    .pop() === name)

                // Return a single child as a property
                if (children.length === 1) {
                    const child = children.pop()
                    if (child) {
                        return buildProxy(child,
                            function (target, name) {
                                return getProperty(target, name.toString())
                            }
                        )
                    }
                }

                // Return a collection of children as an array
                if (children.length > 1) {
                    return children.map(c => buildProxy(c,
                        function (target, name) {
                            return getProperty(target, name.toString())
                        }
                    ))
                }

                return undefined
            }
        )
    }

    return undefined
}

/**
 * Builds a proxy object with common traps for ownKeys and getOwnPropertyDescriptor that allow for functions like
 * JSON.stringify() to work as expected.
 * @param target The object to proxy
 * @param getFunc The get trap used to return a property
 */
function buildProxy<T extends object>(target: T, getFunc: (target: T, p: string | symbol, receiver: any) => any): T {
    return new Proxy(target, {
        set: set,
        ownKeys: ownKeys,
        getOwnPropertyDescriptor: getOwnPropertyDescriptor,
        get: getFunc
    })
}