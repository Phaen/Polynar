//     Polynar.js 1.0
//     http://srv2.blobtech.nl/Polynar
//     (c) 2014 Pablo Kebees
//     Polynar may be freely distributed under the MIT license.

( function() {
	
	// the name of the Polynar object
	var objName = 'Polynar';
	
	// the Polynar object
	var obj = {};
	
	// registering useful character sets
	obj.digit = '0123456789';
	obj.hex = obj.digit + 'ABCDEF';
	obj.lowalpha = 'abcdefghijklmnopqrstuvwxyz';
	obj.hialpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	obj.alpha = obj.lowalpha + obj.hialpha;
	obj.alphanumeric = obj.digit + obj.alpha;
	obj.printable = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
	obj.htmlSafe = ' !#$%\'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
	obj.Base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	obj.urlSafe = obj.alpha + obj.digit + '$-_.+!*\'()'; // http://www.ietf.org/rfc/rfc1738.txt
	
	// the default character set to use
	var defaultCharset = obj.Base64;
	
	// registering our object name, both browser and server side
	if( typeof exports == 'undefined' )
		this[ objName ] = obj;
	else {
		
		if ( typeof module !== 'undefined' && module.exports )
			exports = module.exports = obj;
		
		exports[ objName ] = obj;
		
	}
	
	// define our own is[type] functions
	var isArray = function( obj ) { return toString.call( obj ) === '[object Array]'; };
	var isObject = function( obj ) { return toString.call( obj ) === '[object Object]'; };
	
	// validate encodingOptions
	var validateOptions = function( options ) {
		
		if( typeof options == 'undefined' )
			throw TypeError( 'Undefined encoding options' );
		
		if( !isObject( options ) )
			throw TypeError( options + ' is not an object' );
		
		switch( options.type ) {
			
			case 'number':
				
				// no precision by default
				if( typeof options.precision == 'undefined' )
					options.precision = 1;
				else if( typeof options.precision != 'number' )
					throw TypeError( 'Invalid precision' );
					
				// 1 step by default
				if( typeof options.step == 'undefined' )
					options.step = 1;
				else if( typeof options.step != 'number' || options.step < 0 )
					throw TypeError( 'Invalid step size' );
				
				// if offset defined then set the upper bound regardless of sign
				if( typeof options.offset != 'undefined' ) {
					options.min = 0;
					options.max = options.offset;
				}
				
				// both bounds must be integer
				if(
					typeof options.min != 'number' ||
					typeof options.max != 'number' ||
					options.min % 1 != 0 ||
					options.max % 1 != 0
				)
					throw TypeError( 'Invalid range bound' );
				
				// swap bounds if wrong order
				if( options.min > options.max )
					options.min = options.max + ( options.max = options.min, 0 );
				
				if( ( options.max - options.min ) / options.step % 1 > 0.0000000000000001 ) // fucking floats
					throw TypeError( 'Range bound outside step range' );
				
				break;
			
			case 'string':
				
				if( typeof options.max != 'number' || options.max % 1 != 0 || options.max < 0 )
					throw TypeError( 'Invalid string limit' );
				
				options.charset = validateCharset( options.charset );
				
				break;
				
			case 'item':
				
				if(
					typeof options.list == 'undefined' ||
					!isArray( options.list ) ||
					options.list.length == 0
				)
					throw TypeError( 'Invalid or empty list' );
				
				if( typeof options.sort == 'bool' && options.sort === true )
					options.list = options.list.slice( 0 ).sort(); // slice, so we don't alter the original array
				
				break;
				
			case 'boolean':
				
				break;
			
			case 'object':
				
				if(
					typeof options.template == 'undefined' ||
					!isObject( options.template )
				)
					throw TypeError( 'Invalid object template' );
				
				if(
					typeof options.base != 'undefined' &&
					!isArray( options.base ) &&
					!isObject( options.base ) &&
					typeof options.base != 'function'
				)
					throw TypeError( 'Invalid object base' );
				
				break;
				
			default:
				
				throw TypeError( 'Invalid encoding type' );
			
		}
		
		if( typeof options.limit != 'undefined' )
			if( typeof options.limit != 'number' || options.limit % 1 != 0 || options.limit < 0 )
				throw TypeError( 'Invalid item limit' );
		
		return options;
		
	}
	
	// validate character set
	var validateCharset = function( charset ) {
		
		var errChar = 'Invalid character set', errBin = 'Invalid binary range';
		
		if( typeof charset == 'undefined' )
			charset = defaultCharset;
		else if( typeof charset == 'number' ) {
			
			if( charset % 1 != 0 || charset < 2 )
				throw TypeError( errBin );
			
			charset = [ 0, charset ];
			
		} else if( typeof charset == 'string' ) {
			
			if( charset.match( /(.).*\1/ ) )
				throw Error( errChar );
			
		} else if( isArray( charset ) ) {
			
			if( charset.length != 2 )
				throw TypeError( errBin );
			
			// swap bounds if wrong order
			if( charset[ 0 ] > charset[ 1 ] )
				charset.reverse();
			
			if( charset[ 1 ] - charset[ 0 ] < 2 )
				throw Error( errChar );
			
		} else
			throw TypeError( errChar );
		
		return charset;
		
	}
	
	// our encoder class
	obj.encoder = function() {
		
		if( !this instanceof obj.encoder )
			return new obj.encoder();
		
		this.radii = new Array();
		this.integers = new Array();
		
	}
	
	obj.encoder.prototype.write = function( items, options ) {
		
		var i, pos, chr, size, tempInt, workTpl;
		
		options = validateOptions( options );
		
		if( !isArray( items ) )
			items = [ items ];
		
		if( typeof options.preProc == 'function' )
			for( i in items )
				items[ i ] = options.preProc( items[ i ] );
		
		if( options.limit )
			if( items.length > options.limit )
				throw RangeError( 'Item count exceeds limit' );
			else
				this.compose( items.length, options.limit + 1 );
		
		switch( options.type ) {
			
			case 'item':
				
				for( i in items ) {
					
					pos = options.list.indexOf( items[ i ] );
					
					if( pos == -1 )
						throw Error( 'Item \'' + items[ i ] + '\' not found in list' );
					
					this.compose( pos, options.list.length );
					
				}
				
				break;
			
			case 'number':
				
				for( i in items ) {
					
					if( typeof items[ i ] != 'number' )
						throw TypeError( 'Item \'' + items[ i ] + '\' not a number' );
					
					if( items[ i ] < options.min || items[ i ] > options.max )
						throw RangeError( 'Item \'' + items[ i ] + '\' exceeds range bounds' );
					
					tempInt = ( items[ i ] - options.min ) / options.step;
					
					if( tempInt % 1 > 0.0000000000000001 ) // fucking floats
						throw RangeError( 'Item \'' + items[ i ] + '\' outside step range' );
					
					this.compose( ~~tempInt, ( options.max - options.min ) / options.step + 1 );
					
				}
				
				break;
				
			case 'boolean':
				
				for( i in items ) {
					
					if( typeof items[ i ] != 'boolean' )
						throw TypeError( 'Item \'' + items[ i ] + '\' not boolean' );
					
					this.compose( +items[ i ], 2 );
					
				}
				
				break;
				
			case 'string':
				
				if( typeof options.charset == 'string' )
					size = options.charset[ 1 ] - options.charset[ 0 ] + 1;
				
				for( i in items ) {
					
					if( typeof items[ i ] != 'string' )
						throw TypeError( 'Item \'' + items[ i ] + '\' not string' );
					
					if( items[ i ].length > options.max )
						throw RangeError( 'Item \'' + items[ i ] + '\' exceeds max length' );
					
					this.compose( items[ i ].length, options.max );
					
					for( chr = 0; chr < items[ i ].length; chr ++ )
						if( typeof options.charset == 'string' ) {
							
							pos = options.charset.indexOf( items[ i ].charAt( chr ) );
							
							if( pos == -1 )
								throw Error( 'String not compliant with character set' );
							
							this.compose( pos, options.charset.length );
							
						} else {
							
							pos = items[ i ].charCodeAt( chr );
							
							if( pos < options.charset[ 0 ] || pos > options.charset[ 1 ] )
								throw Error( 'String not compliant with character set' );
							
							this.compose( pos - options.charset[ 0 ], size );
							
						}
						
				}
				
				break;
				
			case 'object':
				
				workTpl = function( obj, tpl ) {
					
					if( options.sort )
						var keys = Object.keys( tpl ).sort();
					else
						var keys = tpl;

					for( var key in keys ) {
						
						if( typeof obj[ key ] == 'undefined' )
							throw ReferenceError( 'Object has no property \'' + key + '\'' );
						
						if( typeof tpl[ key ].type == 'string' )						
							this.write( obj[ key ], tpl[ key ] );
						else if( isObject( tpl[ key ] ) )
							workTpl( obj[ key ], tpl[ key ] );
						else
							throw TypeError( 'Invalid object template' );
						
					}
				}
				
				for( i in items )
					workTpl.call( this, items[ i ], options.template );
				
				break;
		}
		
	}
	
	obj.encoder.prototype.compose = function( integer, radix ) {
		
		this.integers.push( integer );
		this.radii.push( radix );
		
	}
	
	obj.encoder.prototype.toString = function( charset ) {
		
		var binary = false;
		
		charset = validateCharset( charset );
		
		if( typeof charset == 'string' )
			var size = charset.length;
		else
			var size = charset[ 1 ] - charset[ 0 ] + 1;
		
		var radii = 1;
		var current = 0;
		
		var build = function( integer, radix ) {
			
			var left = Math.floor( size / radii );
			
			if( left < 2 ) {
				
				if( typeof charset == 'string' )
					str += charset.charAt( current );
				else
					str += String.fromCharCode( current + charset[ 0 ] );
				
				current = 0;
				radii = 1;
				left = size;
				
			}
			
			if( left >= radix ) {
				
				current += radii * integer;
				radii *= radix;
				
			} else {
				
				var factor = Math.ceil( radix / left );
				
				current += radii * Math.floor( integer / factor );
				radii *= left;
				
				build( integer % factor, factor );
				
			}
			
		}
		
		var str = '';
		for( var i in this.radii )
			build( this.integers[ i ], this.radii[ i ] );
		
		if( radii != 0 )
			if( typeof charset == 'string' )
				str += charset.charAt( current );
			else
				str += String.fromCharCode( current + charset[ 0 ] );
		
		return str;
		
	}
	
	// our decoder class
	obj.decoder = function( str, charset ) {
		
		if( !this instanceof obj.decoder )
			return new obj.decoder( str, charset );
		
		if( typeof str == 'undefined' )
			throw Error( 'Missing first argument' );
		
		str = str.toString();
		
		charset = validateCharset( charset );
		
		if( typeof charset == 'string' )
			this.size = charset.length;
		else
			this.size = charset[ 1 ] - charset[ 0 ] + 1;
		
		this.str = str;
		this.charset = charset;
		this._next();
		
	}
	
	obj.decoder.prototype._next = function() {
		
		if( typeof this.current == 'undefined' )
			this.pointer = 0;
		 else
			this.pointer ++;
		
		if( this.pointer == this.str.length )
			throw new Error( 'Unexpected EOD while parsing' );
		
		this.radii = 1;
		
		if( typeof this.charset == 'string' ) {
			
			this.current = this.charset.indexOf( this.str.charAt( this.pointer ) );
			
			if( this.current == -1 )
				throw Error( 'Byte at ' + this.pointer + ' not found in character set' );
			
		} else {
			
			this.current = this.str.charCodeAt( this.pointer ) - this.charset[ 0 ];
			
			if( this.current > this.charset )
				throw Error( 'Byte at ' + this.pointer + ' does not fit binary range' );
			
		}
		
	}
	
	obj.decoder.prototype.parse = function( radix ) {
		
		var left = Math.floor( this.size / this.radii );
		
		if( left == 1 ) {
			
			if( this.current != 0 )
				throw Error( 'Oversaturated byte at byte ' + this.pointer );
			
			this._next();
			left = this.size;
			
		}
		
		if( left >= radix ) {
			
			var integer = this.current % radix;
			this.current = Math.floor( this.current / radix );
			this.radii *= radix;
			
		} else {
			
			var factor = Math.ceil( radix / left );
			
			var integer = this.current * factor;
			this.current = Math.floor( this.current / left );
			this.radii *= left;
			
			integer += this.parse( factor );
			
		}
		
		return integer;

	}
	
	obj.decoder.prototype.read = function( options, count ) {
		
		var i, obj, chr, size, len, str, ptr;
		
		if( typeof count == 'undefined' )
			var count = 1;
		else if( typeof count != 'number' || count % 1 != 0 || count < 0 )
			throw TypeError( 'Count must be positive integer' );
		
		options = validateOptions( options );
		
		if( options.limit )
			count = this.parse( options.limit + 1 );
		
		var items = new Array();
		
		switch( options.type ) {
			
			case 'item':
				
				for( i = 0; i < count; i++ )
					items.push( options.list[ this.parse( options.list.length ) ] );
				
				break;
				
			case 'number':
				
				for( i = 0; i < count; i++ )
					items.push( this.parse( ( options.max - options.min ) / options.step + 1 ) * options.step + options.min );
				
				break;
				
			case 'boolean':
				
				for( i = 0; i < count; i++ )
					items.push( new Boolean( this.parse( 2 ) ) );
				
				break;
			
			case 'string':
				
				if( typeof options.charset == 'string' )
					size = options.charset[ 1 ] - options.charset[ 0 ] + 1;
				
				for( i = 0; i < count; i++ ) {
					
					len = this.parse( options.max );
					str = '';
					
					for( chr = 0; chr < len; chr ++ )
						if( typeof options.charset == 'string' )
							str += options.charset.charAt( this.parse( options.charset.length ) );
						else
							str += this.parse( size ) + options.charset[ 0 ];
					
					items.push( str );
					
				}
				
				break;
			
			case 'object':
				
				if( typeof options.base != 'undefined' && isArray( options.base ) && options.base.length != count )
					throw Error( 'Items and base count mismatch' );
				
				for( i = 0; i < count; i++ ) {
					
					if( typeof options.base == 'undefined' )
						base = {};
					else if( isArray( options.base ) )
						base = options.base[ i ];
					else if( typeof options.base == 'function' )
						if( options.base.name = '' )
							base = options.base();
						else
							base = new options.base();
					else
						base = options.base;
					
					if( typeof base != 'object' )
						throw TypeError( 'Invalid object base' );
					
					workTpl = function( obj, tpl ) {
						
						if( options.sort )
							var keys = Object.keys( tpl );
						else
							var keys = tpl;

						for( var key in keys ) {
							
							if( typeof tpl[ key ].type == 'string' )
								obj[ key ] = this.read( tpl[ key ] );
							else if( isObject( tpl[ key ] ) ) {
								
								if( typeof obj[ key ] == 'undefined' )
									obj[ key ] = {};
								
								workTpl( obj[ key ], tpl[ key ] );
								
							} else
								throw TypeError( 'Invalid object template' );
							
						}
					}
					
					workTpl.call( this, base, options.template )
					items.push( base );
					
				}
				
				break;
		}
		
		if( typeof options.postProc == 'function' )
			for( i in items )
				items[ i ] = options.postProc( items[ i ] );
				
		if( count == 1 )
			items = items.pop();
		
		return items;
		
	}
	
} ).call( this );